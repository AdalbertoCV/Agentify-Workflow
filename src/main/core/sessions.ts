import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppConfig, RepoConfig } from './config'
import { dropDatabase, type PgConn } from './db'
import { cloneFromGolden, ensureGolden, goldenSha } from './golden'
import { parseEnv, setEnvValue } from './env'
import {
  addWorktree,
  deleteLocalBranch,
  fetchRepo,
  findTicketBranch,
  mainCheckoutOf,
  removeWorktree,
  worktreeRisk
} from './git'
import { linkDir, unlinkTopLevelLinks } from './links'
import { markMigrated, migrationsFingerprint } from './migrations'
import { ensureTrunkWorktree } from './trunk'
import { killTree, processesUsing, run, runShell, type RunningProcess } from './proc'
import { dbNameFor, sessionIdFor, slugify } from './slug'
import { readSessions, writeSessions, type Session, type SessionRepo } from './store'

export type { Session, SessionRepo } from './store'

export function sessionDir(cfg: AppConfig, id: string): string {
  return join(cfg.root, '.worktrees', id)
}

export function listSessions(cfg: AppConfig): Session[] {
  return readSessions(cfg.root)
}

export function repoConfig(cfg: AppConfig, name: string): RepoConfig {
  const r = cfg.repos.find((x) => x.name === name)
  if (!r) throw new Error(`El repo ${name} no está en la configuración`)
  return r
}

/** Connection and source db name from the repo's main checkout env file. */
export function dbSource(repo: RepoConfig): { conn: PgConn; source: string } {
  const db = repo.db!
  const env = parseEnv(readFileSync(join(repo.path, db.envFile), 'utf8'))
  return {
    conn: {
      user: env[db.userKey] ?? '',
      password: env[db.passwordKey] ?? '',
      host: env[db.hostKey] ?? 'localhost',
      port: env[db.portKey] ?? '5432'
    },
    source: env[db.nameKey] ?? ''
  }
}

function agentsMd(cfg: AppConfig, s: Session): string {
  const lines = [
    `# Sesión ${s.ticket} — ${s.title}`,
    '',
    'Esta carpeta agrupa los worktrees de este ticket. Trabaja sólo dentro de ellos.',
    'Antes de editar un repo, lee su propio AGENTS.md / CLAUDE.md.',
    '',
    '| Repo | Worktree | Rama | Base de datos |',
    '|------|----------|------|---------------|',
    ...s.repos.map((r) => `| ${r.name} | ${r.worktree} | ${r.branch} | ${r.db ?? '—'} |`),
    ''
  ]
  const other = cfg.repos.filter((r) => !s.repos.some((x) => x.name === r.name))
  if (other.length) {
    lines.push('Otros repos (sólo lectura, checkout principal):', '')
    for (const r of other) lines.push(`- ${r.name}: ${r.path}`)
    lines.push('')
  }
  return lines.join('\n')
}

export type RepoRisk = { repo: string; dirty: boolean; unpushed: number }
export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'needs-confirm'; risks: RepoRisk[]; processes: RunningProcess[] }

export type DeleteStep = {
  id: string
  label: string
  state: 'pending' | 'running' | 'done' | 'failed'
  ms?: number
  error?: string
}
export type DeletePlan = { risks: RepoRisk[]; processes: RunningProcess[]; steps: DeleteStep[] }
type NeedsConfirm = Extract<DeleteResult, { status: 'needs-confirm' }>

function findSession(cfg: AppConfig, id: string): Session {
  const session = readSessions(cfg.root).find((s) => s.id === id)
  if (!session) throw new Error(`No existe la sesión ${id}`)
  return session
}

function deleteSteps(session: Session): DeleteStep[] {
  const steps: DeleteStep[] = [
    { id: 'stop', label: 'Detener agente y servidores', state: 'pending' },
    { id: 'procs', label: 'Buscar programas que usan la sesión', state: 'pending' }
  ]
  for (const r of session.repos) {
    steps.push({ id: `wt:${r.name}`, label: `${r.name}: quitar worktree`, state: 'pending' })
    if (r.createdBranch)
      steps.push({ id: `branch:${r.name}`, label: `${r.name}: borrar rama ${r.branch}`, state: 'pending' })
    if (r.db) steps.push({ id: `db:${r.name}:${r.db}`, label: `borrar base ${r.db}`, state: 'pending' })
  }
  for (const extra of session.extraDbs ?? [])
    steps.push({ id: `extra-db:${extra.repo}:${extra.db}`, label: `borrar base ${extra.db}`, state: 'pending' })
  steps.push({ id: 'dir', label: 'Borrar carpeta de la sesión', state: 'pending' })
  return steps
}

async function sessionRisks(cfg: AppConfig, session: Session): Promise<RepoRisk[]> {
  const risks: RepoRisk[] = []
  for (const r of session.repos) {
    if (!existsSync(join(r.worktree, '.git'))) continue
    const repo = cfg.repos.find((x) => x.name === r.name)
    const placed = repo ? [...repo.copyFiles, ...repo.linkDirs] : []
    const risk = await worktreeRisk(r.worktree, placed)
    if (risk.dirty || risk.unpushed > 0) risks.push({ repo: r.name, ...risk })
  }
  return risks
}

async function foreignProcesses(session: Session, ignorePids: number[]): Promise<RunningProcess[]> {
  const found = await processesUsing(session.repos.map((r) => r.worktree))
  return found.filter((p) => !ignorePids.includes(p.pid))
}

/** What deleting would remove and what would be lost; touches nothing. */
export async function planDelete(cfg: AppConfig, id: string, opts: { ignorePids?: number[] } = {}): Promise<DeletePlan> {
  const session = findSession(cfg, id)
  return {
    risks: await sessionRisks(cfg, session),
    processes: await foreignProcesses(session, opts.ignorePids ?? []),
    steps: deleteSteps(session)
  }
}

/**
 * Deletes step by step, reporting each one. Anything the user did not confirm (new work, a new
 * foreign program) pauses it before it is touched. Steps on things already gone count as done,
 * so a failed delete can simply run again.
 */
export async function runDelete(
  cfg: AppConfig,
  id: string,
  opts: {
    confirmed: { risks: RepoRisk[]; processes: RunningProcess[] }
    ignorePids?: () => Promise<number[]>
    beforeRemove?: (s: Session) => Promise<void>
    onStep: (steps: DeleteStep[]) => void
  }
): Promise<DeleteResult> {
  const session = findSession(cfg, id)
  const steps = deleteSteps(session)
  const emit = (): void => opts.onStep(steps.map((x) => ({ ...x })))
  const step = async (stepId: string, work: () => Promise<void> | void): Promise<void> => {
    const s = steps.find((x) => x.id === stepId)!
    s.state = 'running'
    emit()
    const t = Date.now()
    try {
      await work()
    } catch (e) {
      s.state = 'failed'
      s.error = (e as Error).message
      s.ms = Date.now() - t
      emit()
      throw e
    }
    s.state = 'done'
    s.ms = Date.now() - t
    emit()
  }

  const unseen = (risks: RepoRisk[]): boolean =>
    risks.some((r) => {
      const seen = opts.confirmed.risks.find((c) => c.repo === r.repo)
      return (r.dirty && !seen?.dirty) || r.unpushed > (seen?.unpushed ?? 0)
    })
  let risks = await sessionRisks(cfg, session)
  if (unseen(risks)) return { status: 'needs-confirm', risks, processes: opts.confirmed.processes } satisfies NeedsConfirm

  await step('stop', () => opts.beforeRemove?.(session))
  // The agent could still write while it was being stopped.
  risks = await sessionRisks(cfg, session)
  if (unseen(risks)) return { status: 'needs-confirm', risks, processes: opts.confirmed.processes }
  let processes: RunningProcess[] = []
  await step('procs', async () => {
    processes = await foreignProcesses(session, (await opts.ignorePids?.()) ?? [])
  })
  if (processes.some((p) => !opts.confirmed.processes.some((c) => c.pid === p.pid)))
    return { status: 'needs-confirm', risks, processes }
  for (const p of processes) await killTree(p.pid)

  const sources = new Set(
    cfg.repos.filter((r) => r.db && existsSync(join(r.path, r.db.envFile))).map((r) => dbSource(r).source)
  )
  const drop = async (repo: RepoConfig | undefined, db: string): Promise<void> => {
    if (!repo?.db) return
    if (!db.startsWith('agentify_') || sources.has(db))
      throw new Error(`Me negué a borrar la base ${db}: no es una base de sesión`)
    await dropDatabase(dbSource(repo).conn, db)
  }
  for (const r of session.repos) {
    const repo = cfg.repos.find((x) => x.name === r.name)
    const repoPath = repo?.path ?? (await mainCheckoutOf(r.worktree))
    await step(`wt:${r.name}`, async () => {
      if (repoPath) await removeWorktree(repoPath, r.worktree)
    })
    if (r.createdBranch)
      await step(`branch:${r.name}`, async () => {
        if (repoPath) await deleteLocalBranch(repoPath, r.branch)
      })
    if (r.db) await step(`db:${r.name}:${r.db}`, () => drop(repo, r.db!))
  }
  for (const extra of session.extraDbs ?? [])
    await step(`extra-db:${extra.repo}:${extra.db}`, () =>
      drop(
        cfg.repos.find((x) => x.name === extra.repo),
        extra.db
      )
    )
  await step('dir', () => {
    const dir = sessionDir(cfg, id)
    if (!existsSync(dir)) return
    for (const r of session.repos) unlinkTopLevelLinks(r.worktree)
    rmSync(dir, { recursive: true, force: true })
  })
  writeSessions(
    cfg.root,
    readSessions(cfg.root).filter((s) => s.id !== id)
  )
  return { status: 'deleted' }
}

/** One-shot delete: asks (returns needs-confirm) unless forced or nothing would be lost. */
export async function deleteSession(
  cfg: AppConfig,
  id: string,
  opts: { force: boolean; beforeRemove?: (s: Session) => Promise<void> }
): Promise<DeleteResult> {
  const plan = await planDelete(cfg, id)
  if ((plan.risks.length || plan.processes.length) && !opts.force)
    return { status: 'needs-confirm', risks: plan.risks, processes: plan.processes }
  return runDelete(cfg, id, { confirmed: plan, beforeRemove: opts.beforeRemove, onStep: () => {} })
}

/** True when the worktree's migration files equal those of the commit the golden db was migrated to. */
export async function sameMigrationsAsGolden(cfg: AppConfig, repo: RepoConfig, wt: string): Promise<boolean> {
  const paths = repo.db?.migrationPaths
  const sha = goldenSha(cfg, repo.name)
  if (!paths?.length || !sha) return false
  try {
    await run('git', ['diff', '--quiet', sha, 'HEAD', '--', ...paths], { cwd: wt })
    return true
  } catch {
    return false
  }
}

export async function createSession(
  cfg: AppConfig,
  input: { ticket: string; title: string; repos: string[]; agent?: string },
  onProgress: (msg: string) => void
): Promise<Session> {
  const id = sessionIdFor(input.ticket)
  if (!id) throw new Error('Escribe el ticket')
  if (!input.repos.length) throw new Error('Elige al menos un repo')
  if (readSessions(cfg.root).some((s) => s.id === id)) throw new Error(`La sesión ${id} ya existe`)
  const dir = sessionDir(cfg, id)
  if (existsSync(dir)) throw new Error(`La carpeta ${dir} ya existe`)

  const undo: (() => Promise<void>)[] = []
  const repos: SessionRepo[] = []
  const fallbackBranch = `${cfg.branchPrefix}/${id}${input.title ? `-${slugify(input.title)}` : ''}`
  try {
    mkdirSync(dir, { recursive: true })
    for (const name of input.repos) {
      const repo = repoConfig(cfg, name)
      const wt = join(dir, name)
      onProgress(`${name}: trayendo lo último de origin…`)
      await fetchRepo(repo.path)
      const branch = (await findTicketBranch(repo.path, cfg.branchPrefix, id)) ?? fallbackBranch
      onProgress(`${name}: creando worktree en ${branch}…`)
      const { createdBranch } = await addWorktree(repo.path, wt, branch, repo.trunk)
      undo.push(async () => {
        await removeWorktree(repo.path, wt)
        if (createdBranch) await deleteLocalBranch(repo.path, branch)
      })
      const entry: SessionRepo = { name, worktree: wt, branch, createdBranch }

      for (const f of repo.copyFiles) {
        const src = join(repo.path, f)
        if (!existsSync(src)) continue
        mkdirSync(dirname(join(wt, f)), { recursive: true })
        copyFileSync(src, join(wt, f))
      }
      const linkBase = repo.linkFrom === 'trunk' && repo.linkDirs.length ? await ensureTrunkWorktree(cfg, repo, true, onProgress) : repo.path
      for (const d of repo.linkDirs) {
        const target = join(linkBase, d)
        if (existsSync(target) && !existsSync(join(wt, d))) linkDir(target, join(wt, d))
        if (!existsSync(target) || readdirSync(target).every((n) => n.startsWith('.')))
          onProgress(`⚠ ${name}: ${d} está vacío en ${linkBase}; instálalo ahí o Probar fallará`)
      }
      const env: Record<string, string> = { AGENTIFY_SESSION: id, AGENTIFY_ROOT: cfg.root }
      if (repo.db) {
        const { conn } = dbSource(repo)
        await ensureGolden(cfg, repo, onProgress)
        const target = dbNameFor(id)
        onProgress(`${name}: clonando la base madre → ${target}…`)
        await cloneFromGolden(cfg, repo, target)
        undo.push(() => dropDatabase(conn, target))
        const envFile = join(wt, repo.db.envFile)
        const text = existsSync(envFile) ? readFileSync(envFile, 'utf8') : ''
        writeFileSync(envFile, setEnvValue(text, repo.db.nameKey, target))
        entry.db = target
        env.AGENTIFY_DB_NAME = target
        env[repo.db.nameKey] = target
      }
      if (entry.db && (await sameMigrationsAsGolden(cfg, repo, wt))) {
        onProgress(`${name}: la rama no trae migraciones nuevas; la base ya está al día`)
      } else {
        for (const line of repo.setup) {
          onProgress(`${name}: ${line}`)
          await runShell(line, { cwd: wt, env })
        }
      }
      if (entry.db) {
        const fp = await migrationsFingerprint(repo, wt)
        if (fp) markMigrated(dir, name, fp)
      }
      repos.push(entry)
    }
    const session: Session = {
      id,
      ticket: input.ticket.trim(),
      title: input.title.trim(),
      repos,
      agent: input.agent ?? cfg.defaultAgent,
      createdAt: new Date().toISOString(),
      imported: false
    }
    writeFileSync(join(dir, 'AGENTS.md'), agentsMd(cfg, session))
    writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
    writeSessions(cfg.root, [...readSessions(cfg.root), session])
    for (const r of repos) {
      for (const line of repoConfig(cfg, r.name).warm ?? [])
        void runShell(line, { cwd: r.worktree, env: { AGENTIFY_SESSION: id, AGENTIFY_ROOT: cfg.root } }).catch(() => {})
    }
    onProgress('Sesión lista')
    return session
  } catch (e) {
    onProgress('Algo falló; deshaciendo…')
    for (const step of undo.reverse()) await step().catch(() => {})
    rmSync(dir, { recursive: true, force: true })
    throw e
  }
}
