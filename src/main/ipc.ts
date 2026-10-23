import { app, BrowserWindow, clipboard, ClipboardItem, dialog, ipcMain, shell, webContents } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentState, installClaudeHooks } from './core/agentState'
import {
  configPath,
  loadConfig,
  saveConfig,
  writeStarterConfig,
  type AgentConfig,
  type AppConfig,
  type RepoConfig,
  type TicketProviderId
} from './core/config'
import { checkConnectors } from './core/connectors'
import { commitAndPush } from './core/commit'
import { sessionDiff } from './core/diff'
import { ensureGolden, goldenCopiedAt, prepareSpare } from './core/golden'
import { adoptLooseWorktrees } from './core/importer'
import { githubRepos } from './core/github'
import type { Issue } from './core/linear'
import { onboardPrompt, readOnboardResult, saveRepo, startOnboarding } from './core/onboard'
import { gitBash, runResolved, runShell } from './core/proc'
import { Runner } from './core/runner'
import { createSession, planDelete, runDelete, sessionDir } from './core/sessions'
import { readSessions, updateSession, type Session } from './core/store'
import { providerFor } from './core/tickets'
import { PtyManager } from './pty'
import { getSecret, setSecret } from './secrets'
import type { SessionInfo, DeleteProgress } from '../shared/api'

type TerminalSpec = { cwd: string; agent: AgentConfig; firstArgs?: string[]; env?: Record<string, string> }

const ptys = new PtyManager()
const runner = new Runner()
const terminals = new Map<string, TerminalSpec>()
let cfg: AppConfig | null = null

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

function loadRoot(): AppConfig | null {
  if (!existsSync(settingsFile())) return null
  const { root } = JSON.parse(readFileSync(settingsFile(), 'utf8'))
  if (!root || !existsSync(configPath(root))) return null
  return loadConfig(root)
}

function requireCfg(): AppConfig {
  if (!cfg) cfg = loadRoot()
  if (!cfg) throw new Error('Primero elige la carpeta de tus repos')
  return cfg
}

function findSession(id: string): Session {
  const s = readSessions(requireCfg().root).find((x) => x.id === id)
  if (!s) throw new Error(`No existe la sesión ${id}`)
  return s
}

function agentOf(c: AppConfig, id: string): AgentConfig {
  return c.agents.find((a) => a.id === id) ?? c.agents.find((a) => a.id === c.defaultAgent) ?? c.agents[0]
}

/** Imported sessions have no folder of their own yet: give them one with the usual AGENTS.md. */
function ensureSessionDir(c: AppConfig, s: Session): string {
  const dir = sessionDir(c, s.id)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    const rows = s.repos.map((r) => `| ${r.name} | ${r.worktree} | ${r.branch} |`).join('\n')
    writeFileSync(
      join(dir, 'AGENTS.md'),
      `# Sesión ${s.ticket} — ${s.title}\n\nLee el AGENTS.md de cada repo antes de editarlo.\n\n| Repo | Worktree | Rama |\n|---|---|---|\n${rows}\n`
    )
    writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n')
  }
  return dir
}

function copyPng(png: Buffer): Promise<void> {
  return clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) })])
}

const GOLDEN_MAX_AGE_MS = 12 * 60 * 60 * 1000

/**
 * Keeps each golden db ready in the background so creating a session only clones it:
 * re-copied from the local db when older than 12 h, re-migrated whenever trunk moved.
 */
function warmGoldens(): void {
  const c = cfg
  if (!c) return
  for (const repo of c.repos.filter((r) => r.db && existsSync(r.path))) {
    const at = goldenCopiedAt(c, repo.name)
    const recopy = repo.db!.source !== 'empty' && (!at || Date.now() - at.getTime() > GOLDEN_MAX_AGE_MS)
    void ensureGolden(c, repo, (m) => broadcast('sessions:progress', m), { recopy })
      .then(() => prepareSpare(c, repo))
      .catch((e) =>
      broadcast('sessions:progress', `✗ ${(e as Error).message}`)
    )
  }
}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
}

export function registerIpc(): void {
  cfg = (() => {
    try {
      return loadRoot()
    } catch {
      return null
    }
  })()

  ptys.onData((id, d) => broadcast('pty:data', id, d))
  ptys.onExit((id, code) => broadcast('pty:exit', id, code))

  ipcMain.handle('config:get', () => {
    cfg = loadRoot()
    return cfg
  })

  ipcMain.handle('config:choose-root', async () => {
    const r = await dialog.showOpenDialog({
      title: 'Elige la carpeta donde viven tus repos',
      properties: ['openDirectory']
    })
    if (r.canceled || !r.filePaths[0]) return cfg
    const root = r.filePaths[0]
    if (!existsSync(configPath(root))) await writeStarterConfig(root)
    writeFileSync(settingsFile(), JSON.stringify({ root }))
    cfg = loadConfig(root)
    warmGoldens()
    return cfg
  })

  ipcMain.handle('sessions:list', (): SessionInfo[] => {
    const c = requireCfg()
    const now = Date.now()
    return readSessions(c.root).map((s) => {
      const agent = agentOf(c, s.agent)
      const open = ptys.isOpen(s.id)
      const deleting = deletions.get(s.id)?.phase
      return {
        ...s,
        deleting: deleting === 'running' ? 'running' : deleting === 'failed' ? 'failed' : undefined,
        test: runner.status(s.id),
        url: runner.url(s.id),
        agentState: open
          ? agentState(sessionDir(c, s.id), agent.waiting ?? 'idle', ptys.lastOutputAt(s.id), now)
          : 'off'
      }
    })
  })

  ipcMain.handle('sessions:create', async (e, input) => {
    const c = requireCfg()
    const s = await createSession(c, input, (msg) => e.sender.send('sessions:progress', msg))
    broadcast('sessions:changed')
    return s
  })

  // Deletes run in main and outlive the dialog: closing it never loses track of one.
  const deletions = new Map<string, DeleteProgress>()
  const publish = (p: DeleteProgress): void => {
    deletions.set(p.id, p)
    broadcast('sessions:delete-progress', p)
  }

  ipcMain.handle('sessions:delete-plan', async (_e, id: string): Promise<DeleteProgress> => {
    const current = deletions.get(id)
    if (current && current.phase !== 'confirm') return current
    const plan = await planDelete(requireCfg(), id, { ignorePids: await runner.ownedPids(id) })
    const p: DeleteProgress = { id, phase: 'confirm', plan, steps: plan.steps }
    deletions.set(id, p)
    return p
  })

  ipcMain.handle('sessions:delete-start', (_e, id: string) => {
    const current = deletions.get(id)
    if (!current || current.phase === 'running' || current.phase === 'deleted') return
    const c = requireCfg()
    publish({ ...current, phase: 'running', error: undefined })
    void runDelete(c, id, {
      confirmed: current.plan,
      ignorePids: () => runner.ownedPids(id),
      beforeRemove: async (s) => {
        await ptys.forget(s.id)
        await runner.stop(s.id)
      },
      onStep: (steps) => publish({ ...deletions.get(id)!, steps })
    })
      .then((r) => {
        const now = deletions.get(id)!
        if (r.status === 'needs-confirm')
          return publish({ ...now, phase: 'paused', plan: { ...now.plan, risks: r.risks, processes: r.processes } })
        publish({ ...now, phase: 'deleted' })
        setTimeout(() => deletions.get(id)?.phase === 'deleted' && deletions.delete(id), 5000)
      })
      .catch((e) => publish({ ...deletions.get(id)!, phase: 'failed', error: (e as Error).message }))
      .finally(() => broadcast('sessions:changed'))
  })

  ipcMain.handle('sessions:delete-state', (_e, id: string) => deletions.get(id) ?? null)

  ipcMain.handle('sessions:adopt', async () => {
    const n = await adoptLooseWorktrees(requireCfg())
    if (n) broadcast('sessions:changed')
    return n
  })

  ipcMain.handle('sessions:set-agent', async (_e, id: string, agent: string) => {
    updateSession(requireCfg().root, id, { agent })
    await ptys.forget(id)
    broadcast('sessions:changed')
  })

  ipcMain.handle('pty:open', async (_e, id: string) => {
    const spec = terminals.get(id)
    if (spec) return ptys.open(id, spec.cwd, spec.agent, spec.env, spec.firstArgs)
    const c = requireCfg()
    const s = findSession(id)
    const dir = ensureSessionDir(c, s)
    const agent = agentOf(c, s.agent)
    if (agent.waiting === 'claude-hooks') installClaudeHooks(dir)
    const prompt = c.startPrompt?.replace(/{ticket}/g, s.ticket).replace(/{title}/g, s.title)
    await ptys.open(id, dir, agent, { AGENTIFY_SESSION: id }, undefined, s.imported ? undefined : prompt)
  })
  ipcMain.handle('pty:history', (_e, id: string) => ptys.history(id))
  ipcMain.on('pty:write', (_e, id: string, data: string) => ptys.write(id, data))
  ipcMain.on('pty:resize', (_e, id: string, cols: number, rows: number) => ptys.resize(id, cols, rows))

  ipcMain.handle('test:start', async (_e, id: string) => {
    const c = requireCfg()
    const r = await runner.start(c, findSession(id), (repo, line) =>
      broadcast('test:log', id, `[${repo}] ${line}`)
    )
    broadcast('sessions:changed')
    return r
  })
  ipcMain.handle('test:stop', async (_e, id: string) => {
    await runner.stop(id)
    broadcast('sessions:changed')
  })
  ipcMain.handle('test:logs', (_e, id: string) => runner.logs(requireCfg(), id))

  ipcMain.handle('capture', async (_e, wcId: number, rect?: Electron.Rectangle) => {
    const wc = webContents.fromId(wcId)
    if (!wc) throw new Error('No encontré la página')
    if (rect) {
      await copyPng((await wc.capturePage(rect)).toPNG())
      return
    }
    const dbg = wc.debugger
    const attached = dbg.isAttached()
    try {
      if (!attached) dbg.attach('1.3')
      const { data } = await dbg.sendCommand('Page.captureScreenshot', {
        format: 'png',
        captureBeyondViewport: true
      })
      await copyPng(Buffer.from(data, 'base64'))
    } catch {
      await copyPng((await wc.capturePage()).toPNG())
    } finally {
      if (!attached && dbg.isAttached()) dbg.detach()
    }
  })

  ipcMain.handle('diff', (_e, id: string) => sessionDiff(requireCfg(), findSession(id)))
  ipcMain.handle('commit', (_e, id: string, message: string) => commitAndPush(requireCfg(), findSession(id), message))
  ipcMain.handle('open:path', (_e, p: string) => shell.openPath(p))
  ipcMain.handle('open:external', (_e, u: string) => shell.openExternal(u))

  const tickets = (): ReturnType<typeof providerFor> =>
    providerFor(requireCfg(), {
      secret: getSecret,
      fetchFn: fetch,
      gh: async (args) => (await runResolved('gh', args, { cwd: requireCfg().root })).stdout
    })
  ipcMain.handle('tickets:provider', () => tickets().id)
  ipcMain.handle('tickets:set-provider', (_e, provider: TicketProviderId, extra?: string[]) => {
    const c = requireCfg()
    const repos = extra ?? c.tickets?.githubRepos
    cfg = { ...c, tickets: repos?.length ? { provider, githubRepos: repos } : { provider } }
    saveConfig(cfg)
    return cfg
  })
  ipcMain.handle('tickets:list', () => tickets().list())
  ipcMain.handle('tickets:repos-for', (_e, issue: Issue) => tickets().reposFor(issue))
  ipcMain.handle('tickets:github-repos', () => githubRepos(requireCfg()))
  ipcMain.handle('secrets:set', (_e, name: string, value: string) => setSecret(name, value))

  ipcMain.handle('connectors', () =>
    checkConnectors(requireCfg(), {
      run: (cmd, args, env) => runResolved(cmd, args, { cwd: requireCfg().root, env }),
      shell: (line) => runShell(line, { cwd: requireCfg().root }),
      secret: getSecret,
      fetchFn: fetch
    })
  )

  ipcMain.handle('connectors:run-fix', async (_e, command: string) => {
    const id = `fix:${Date.now()}`
    terminals.set(id, {
      cwd: requireCfg().root,
      agent: { id: 'bash', label: 'bash', command: await gitBash(), args: [], resumeArgs: [] },
      firstArgs: ['-lc', `${command}; echo; read -n1 -p "Listo. Presiona una tecla para cerrar."`]
    })
    return id
  })

  ipcMain.handle('repos:onboard-start', async (_e, src: { cloneUrl?: string; path?: string }) => {
    const c = requireCfg()
    const r = await startOnboarding(c, src)
    const promptFile = join(r.workDir, 'PROMPT.md')
    writeFileSync(promptFile, onboardPrompt(r.repoName, r.repoPath, r.workDir, c))
    const agent = agentOf(c, c.defaultAgent)
    const terminalId = `onboard:${r.repoName}:${Date.now()}`
    terminals.set(terminalId, {
      cwd: c.root,
      agent,
      firstArgs: [
        ...agent.args,
        `Read ${promptFile.replace(/\\/g, '/')} and follow its instructions exactly.`
      ]
    })
    return { ...r, terminalId }
  })
  ipcMain.handle('repos:onboard-read', (_e, workDir: string) => {
    if (!existsSync(join(workDir, 'repo.json'))) return null
    return readOnboardResult(workDir, requireCfg().root)
  })
  ipcMain.handle('repos:save', (_e, repo: RepoConfig) => {
    cfg = saveRepo(requireCfg(), repo)
    return cfg
  })

  ipcMain.handle('repos:golden-info', () => {
    const c = requireCfg()
    return Object.fromEntries(
      c.repos.filter((r) => r.db).map((r) => [r.name, goldenCopiedAt(c, r.name)?.toISOString() ?? null])
    )
  })
  ipcMain.handle('repos:golden-refresh', async (_e, name: string) => {
    const c = requireCfg()
    const repo = c.repos.find((r) => r.name === name)
    if (!repo?.db) throw new Error(`${name} no tiene base de datos`)
    await ensureGolden(c, repo, (m) => broadcast('sessions:progress', m), { recopy: true })
  })

  warmGoldens()

  // Stop every session's servers before quitting, or their processes outlive the app.
  let quitting = false
  app.on('before-quit', (e) => {
    if (quitting) return
    quitting = true
    e.preventDefault()
    void Promise.all([ptys.killAll(), runner.stopAll()]).finally(() => app.exit(0))
  })
}
