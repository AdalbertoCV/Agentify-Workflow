import { spawn, type ChildProcess } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import type { AppConfig, RepoConfig } from './config'
import { databaseExists, dropDatabase } from './db'
import { cloneFromGolden, ensureGolden } from './golden'
import { markMigrated, migratedFingerprint, migrationsFingerprint } from './migrations'
import { allocatePorts, listenersOn, portAnswers } from './ports'
import { gitBash, run, runShell } from './proc'
import { dbSource, sameMigrationsAsGolden, sessionDir } from './sessions'
import { dbNameFor } from './slug'
import { readSessions, updateSession, type Session } from './store'
import { ensureTrunkWorktree, linkSource, relinkEmptyDirs } from './trunk'

export type TestStatus = 'stopped' | 'starting' | 'running' | 'error'

const READY_TIMEOUT_MS = 180_000

type Proc = { repo: RepoConfig; child: ChildProcess; cwd: string; env: Record<string, string> }
type Run = { status: TestStatus; procs: Proc[]; url?: string; logFile: string; ports: Record<string, number> }

export function resolveStack(
  cfg: AppConfig,
  session: Session
): { repo: RepoConfig; fromSession: boolean }[] {
  const inSession = new Set(session.repos.map((r) => r.name))
  const ordered: RepoConfig[] = []
  const visiting = new Set<string>()
  const visit = (name: string): void => {
    if (ordered.some((r) => r.name === name) || visiting.has(name)) return
    const repo = cfg.repos.find((r) => r.name === name)
    if (!repo?.run) return
    visiting.add(name)
    for (const dep of repo.run.needs ?? []) visit(dep)
    visiting.delete(name)
    ordered.push(repo)
  }
  for (const r of session.repos) visit(r.name)
  return ordered.map((repo) => ({ repo, fromSession: inSession.has(repo.name) }))
}

function envName(repo: string): string {
  return `AGENTIFY_PORT_${repo.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`
}

function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return Promise.resolve()
  if (process.platform === 'win32')
    return run('taskkill', ['/T', '/F', '/PID', String(pid)], { cwd: process.cwd() })
      .then(() => {})
      .catch(() => {})
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    // already gone
  }
  return Promise.resolve()
}

export class Runner {
  private runs = new Map<string, Run>()

  status(id: string): TestStatus {
    return this.runs.get(id)?.status ?? 'stopped'
  }

  ports(id: string): Record<string, number> {
    return this.runs.get(id)?.ports ?? {}
  }

  url(id: string): string | undefined {
    return this.runs.get(id)?.url
  }

  logs(cfg: AppConfig, id: string): string {
    const f = this.runs.get(id)?.logFile ?? join(sessionDir(cfg, id), 'logs', 'probar.log')
    return existsSync(f) ? readFileSync(f, 'utf8').slice(-100_000) : ''
  }

  /** Trunk worktrees a running session is using must not be reset under it. */
  private trunkInUse(repo: string): boolean {
    for (const r of this.runs.values())
      if (r.status !== 'stopped' && r.procs.some((p) => p.repo.name === repo && p.cwd.includes('.agentify')))
        return true
    return false
  }

  async start(
    cfg: AppConfig,
    session: Session,
    onLog: (repo: string, line: string) => void
  ): Promise<{ url?: string }> {
    if (this.status(session.id) === 'running' || this.status(session.id) === 'starting')
      return { url: this.url(session.id) }
    const logDir = join(sessionDir(cfg, session.id), 'logs')
    mkdirSync(logDir, { recursive: true })
    const current: Run = { status: 'starting', procs: [], logFile: join(logDir, 'probar.log'), ports: {} }
    this.runs.set(session.id, current)
    const log = (repo: string, line: string): void => {
      appendFileSync(current.logFile, `[${repo}] ${line}\n`)
      onLog(repo, line)
    }
    try {
      const stack = resolveStack(cfg, session)
      if (!stack.length) throw new Error('Ningún repo de esta sesión tiene script de arranque. Agrégalo en Repos.')
      const ports = await allocatePorts(cfg, session.id, new Set())
      current.ports = ports
      const portEnv = Object.fromEntries(Object.entries(ports).map(([k, v]) => [envName(k), String(v)]))
      const bash = await gitBash()

      for (const { repo, fromSession } of stack) {
        const own = session.repos.find((r) => r.name === repo.name)
        const cwd = fromSession
          ? own!.worktree
          : await ensureTrunkWorktree(cfg, repo, !this.trunkInUse(repo.name), (m) => log(repo.name, m))
        await relinkEmptyDirs(cfg, repo, cwd, (m) => log(repo.name, m))
        for (const d of repo.linkDirs) {
          const p = join(cwd, d)
          if (!existsSync(p) || readdirSync(p).every((n) => n.startsWith('.')))
            throw new Error(
              `${repo.name}: ${d} está vacío (comparte el de ${linkSource(cfg, repo)}). Instálalo ahí (por ejemplo npm install) y vuelve a Probar.`
            )
        }
        const env: Record<string, string> = {
          ...portEnv,
          AGENTIFY_SESSION: session.id,
          AGENTIFY_ROOT: cfg.root,
          PYTHONUTF8: '1'
        }
        if (ports[repo.name]) env.AGENTIFY_PORT = String(ports[repo.name])
        if (repo.db) {
          const dbName = own?.db ?? (await this.ensureSessionDb(cfg, session, repo, cwd, log))
          // The branch may have gained migrations since the session db was last migrated.
          if (own?.db) {
            const fp = await migrationsFingerprint(repo, cwd)
            if (!fp || fp !== migratedFingerprint(sessionDir(cfg, session.id), repo.name)) {
              await this.migrate(cfg, repo, cwd, dbName, log)
              if (fp) markMigrated(sessionDir(cfg, session.id), repo.name, fp)
            }
          }
          env.AGENTIFY_DB_NAME = dbName
          env[repo.db.nameKey] = dbName
        }
        const script = isAbsolute(repo.run!.script) ? repo.run!.script : join(cfg.root, repo.run!.script)
        if (!existsSync(script)) throw new Error(`${repo.name}: no existe el script ${script}`)
        log(repo.name, `▶ ${fromSession ? 'rama de la sesión' : `main fresco (${repo.trunk})`} · puerto ${ports[repo.name] ?? '—'}`)
        const child = spawn(bash, ['-lc', `"${script.replace(/\\/g, '/')}"`], {
          cwd,
          env: { ...process.env, ...env },
          windowsHide: true,
          detached: process.platform !== 'win32'
        })
        const proc: Proc = { repo, child, cwd, env }
        current.procs.push(proc)
        let tail: string[] = []
        const onChunk = (d: Buffer): void => {
          for (const line of d.toString().split(/\r?\n/)) {
            if (!line) continue
            tail = [...tail, line].slice(-30)
            log(repo.name, line)
          }
        }
        child.stdout?.on('data', onChunk)
        child.stderr?.on('data', onChunk)
        let exited: number | null | undefined
        child.on('exit', (code) => {
          exited = code
          if (current.status === 'running') {
            current.status = 'error'
            log(repo.name, `■ terminó con código ${code}`)
          }
        })
        if (repo.run!.port) {
          const port = ports[repo.name]
          const deadline = Date.now() + READY_TIMEOUT_MS
          while (!(await portAnswers(port))) {
            if (exited !== undefined)
              throw new Error(`${repo.name} terminó (código ${exited}):\n${tail.join('\n')}`)
            if (Date.now() > deadline)
              throw new Error(`${repo.name} no abrió el puerto ${port} en 3 min:\n${tail.join('\n')}`)
            await new Promise((r) => setTimeout(r, 500))
          }
          log(repo.name, `✓ escuchando en ${port}`)
        } else {
          await new Promise((r) => setTimeout(r, 1500))
          if (exited !== undefined && exited !== 0)
            throw new Error(`${repo.name} terminó (código ${exited}):\n${tail.join('\n')}`)
        }
      }

      const browserRepo =
        stack.find((s) => s.repo.name === cfg.browserRepo && s.repo.run?.url) ??
        stack.find((s) => s.repo.run?.url)
      if (browserRepo)
        current.url = browserRepo.repo.run!.url!.replace('{port}', String(ports[browserRepo.repo.name]))
      current.status = 'running'
      return { url: current.url }
    } catch (e) {
      await this.killProcs(current)
      current.status = 'error'
      log('agentify', `✗ ${(e as Error).message}`)
      throw e
    }
  }

  /** A session without its own copy of a db repo still gets its own db (from trunk). */
  private async ensureSessionDb(
    cfg: AppConfig,
    session: Session,
    repo: RepoConfig,
    cwd: string,
    log: (repo: string, line: string) => void
  ): Promise<string> {
    const name = dbNameFor(session.id)
    const { conn } = dbSource(repo)
    // The trunk checkout was refreshed just before; the golden follows it without touching it again.
    await ensureGolden(cfg, repo, (m) => log(repo.name, m), { refreshTrunk: false })
    const migrate = (): Promise<void> => this.migrate(cfg, repo, cwd, name, log)
    // Fresh clone of the golden (already at trunk); a branch checkout may still add its own migrations.
    const fresh = async (): Promise<void> => {
      log(repo.name, `clonando la base madre → ${name}…`)
      await cloneFromGolden(cfg, repo, name)
      const s = readSessions(cfg.root).find((x) => x.id === session.id)
      const extraDbs = [...(s?.extraDbs ?? []).filter((d) => d.repo !== repo.name), { repo: repo.name, db: name }]
      updateSession(cfg.root, session.id, { extraDbs })
      session.extraDbs = extraDbs
      if (!(await sameMigrationsAsGolden(cfg, repo, cwd))) await migrate()
    }
    if (!(await databaseExists(conn, name))) {
      await fresh()
      return name
    }
    // An existing db may be behind main, or come from an older copy that no longer migrates.
    try {
      await migrate()
    } catch {
      log(repo.name, `la base ${name} no migra (es de una versión anterior); la recreo desde la base madre…`)
      await dropDatabase(conn, name)
      await fresh()
    }
    return name
  }

  private async migrate(
    cfg: AppConfig,
    repo: RepoConfig,
    cwd: string,
    name: string,
    log: (repo: string, line: string) => void
  ): Promise<void> {
    for (const line of repo.setup) {
      log(repo.name, line)
      await runShell(line, { cwd, env: { [repo.db!.nameKey]: name, AGENTIFY_DB_NAME: name, AGENTIFY_ROOT: cfg.root } })
    }
  }

  private async killProcs(r: Run): Promise<void> {
    for (const p of [...r.procs].reverse()) {
      if (p.repo.run?.stop) {
        const stop = isAbsolute(p.repo.run.stop) ? p.repo.run.stop : join(p.env.AGENTIFY_ROOT, p.repo.run.stop)
        await runShell(`"${stop.replace(/\\/g, '/')}"`, { cwd: p.cwd, env: p.env }).catch(() => {})
      }
      await killTree(p.child.pid)
    }
    r.procs = []
    // Servers can outlive their launcher (uv → python, detached children): anything still
    // listening on this session's ports belongs to it and goes too.
    for (const port of Object.values(r.ports)) for (const pid of await listenersOn(port)) await killTree(pid)
  }

  async stop(id: string): Promise<void> {
    const r = this.runs.get(id)
    if (!r) return
    await this.killProcs(r)
    r.status = 'stopped'
    r.url = undefined
  }

  async stopAll(): Promise<void> {
    for (const id of this.runs.keys()) await this.stop(id)
  }
}
