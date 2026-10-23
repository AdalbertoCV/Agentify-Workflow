import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { resolveCommand, run } from './proc'

export const CONFIG_FILE = 'agentify.config.json'

export type DbConfig = {
  envFile: string
  nameKey: string
  userKey: string
  passwordKey: string
  hostKey: string
  portKey: string
  /** 'local' (default): copy of the developer's db. 'empty': built from migrations + `seed`. */
  source?: 'local' | 'empty'
  /** Commands run on a freshly migrated empty db (example user and data). */
  seed?: string[]
  /**
   * Paths holding migrations (git pathspecs). When a session branch has the same files there as the
   * golden's trunk commit, the cloned db is already up to date and `setup` is skipped.
   */
  migrationPaths?: string[]
}

export type RunConfig = {
  script: string
  stop?: string
  port?: boolean
  needs?: string[]
  url?: string
}

export type RepoConfig = {
  name: string
  path: string
  trunk: string
  copyFiles: string[]
  linkDirs: string[]
  db?: DbConfig
  setup: string[]
  /** 'trunk': linked dirs come from the app's fresh-trunk copy (kept installed); default 'main' = your checkout. */
  linkFrom?: 'main' | 'trunk'
  /** Dependency install run in the trunk copy whenever a watched file (lockfile) changes on main. */
  install?: { command: string; watch: string[] }
  /** Commands run in the background right after a session is created (e.g. precompiling), so Probar starts faster. */
  warm?: string[]
  run?: RunConfig
}

export type AgentConfig = {
  id: string
  label: string
  command: string
  args: string[]
  resumeArgs: string[]
  waiting?: 'claude-hooks' | 'idle'
}

export type TestUser = { label?: string; email: string; password: string }

export type ExtraCheck = { label: string; command: string; expect?: string; fix?: string }

export type AppConfig = {
  root: string
  branchPrefix: string
  repos: RepoConfig[]
  agents: AgentConfig[]
  defaultAgent: string
  browserRepo?: string
  extraChecks?: ExtraCheck[]
  /** First message to the agent in a new session; `{ticket}` and `{title}` are filled in. */
  startPrompt?: string
  /** Accounts the seeded databases contain, shown in the browser bar to copy or fill a login. */
  testUsers?: TestUser[]
}

export class ConfigError extends Error {
  constructor(public problems: string[]) {
    super(`Configuración inválida:\n- ${problems.join('\n- ')}`)
  }
}

const DB_KEYS: (keyof DbConfig)[] = [
  'envFile',
  'nameKey',
  'userKey',
  'passwordKey',
  'hostKey',
  'portKey'
]

/** Normalizes one repo entry; pushes problems instead of throwing. */
export function normalizeRepo(raw: any, root: string, problems: string[]): RepoConfig {
  const name = typeof raw?.name === 'string' ? raw.name : ''
  const label = name || '(sin nombre)'
  if (!name) problems.push('Un repo no tiene "name"')
  if (typeof raw?.trunk !== 'string' || !raw.trunk) problems.push(`${label}: falta "trunk"`)
  const path = typeof raw?.path === 'string' && raw.path ? raw.path : name
  if (raw?.db) {
    for (const k of DB_KEYS) {
      if (typeof raw.db[k] !== 'string') problems.push(`${label}: db.${k} falta`)
    }
  }
  if (raw?.run && typeof raw.run.script !== 'string') problems.push(`${label}: run.script falta`)
  return {
    name,
    path: isAbsolute(path) ? path : join(root, path),
    trunk: raw?.trunk ?? '',
    copyFiles: Array.isArray(raw?.copyFiles) ? raw.copyFiles : [],
    linkDirs: Array.isArray(raw?.linkDirs) ? raw.linkDirs : [],
    db: raw?.db,
    setup: Array.isArray(raw?.setup) ? raw.setup : [],
    warm: Array.isArray(raw?.warm) ? raw.warm : undefined,
    linkFrom: raw?.linkFrom === 'trunk' ? 'trunk' : undefined,
    install: raw?.install,
    run: raw?.run
  }
}

export function parseConfig(raw: any, root: string): AppConfig {
  const problems: string[] = []
  if (typeof raw?.branchPrefix !== 'string') problems.push('Falta "branchPrefix"')
  const repos = (Array.isArray(raw?.repos) ? raw.repos : []).map((r: any) =>
    normalizeRepo(r, root, problems)
  )
  const agents: AgentConfig[] = (Array.isArray(raw?.agents) ? raw.agents : []).map((a: any) => ({
    id: a.id,
    label: a.label ?? a.id,
    command: a.command,
    args: a.args ?? [],
    resumeArgs: a.resumeArgs ?? a.args ?? [],
    waiting: a.waiting
  }))
  if (!agents.some((a) => a.id === raw?.defaultAgent))
    problems.push(`El agente por defecto "${raw?.defaultAgent}" no existe`)
  if (raw?.browserRepo && !repos.some((r) => r.name === raw.browserRepo))
    problems.push(`browserRepo "${raw.browserRepo}" no es un repo de la config`)
  if (problems.length) throw new ConfigError(problems)
  return {
    root,
    branchPrefix: raw.branchPrefix,
    repos,
    agents,
    defaultAgent: raw.defaultAgent,
    browserRepo: raw.browserRepo,
    extraChecks: raw.extraChecks ?? [],
    startPrompt: typeof raw.startPrompt === 'string' ? raw.startPrompt : undefined,
    testUsers: Array.isArray(raw.testUsers)
      ? raw.testUsers.filter((u: any) => typeof u?.email === 'string' && typeof u?.password === 'string')
      : undefined
  }
}

export function configPath(root: string): string {
  return join(root, CONFIG_FILE)
}

export function loadConfig(root: string): AppConfig {
  const raw = JSON.parse(readFileSync(configPath(root), 'utf8'))
  return parseConfig(raw, root)
}

/** Writes the config back, storing repo paths relative to root when they live under it. */
export function saveConfig(cfg: AppConfig): void {
  const prefix = cfg.root.replace(/[\\/]+$/, '') + (cfg.root.includes('\\') ? '\\' : '/')
  const out = {
    branchPrefix: cfg.branchPrefix,
    defaultAgent: cfg.defaultAgent,
    browserRepo: cfg.browserRepo,
    agents: cfg.agents,
    extraChecks: cfg.extraChecks,
    startPrompt: cfg.startPrompt,
    testUsers: cfg.testUsers,
    repos: cfg.repos.map((r) => ({
      ...r,
      path: r.path.startsWith(prefix) ? r.path.slice(prefix.length) : r.path
    }))
  }
  writeFileSync(configPath(cfg.root), JSON.stringify(out, null, 2) + '\n')
}

async function trunkOf(repoPath: string): Promise<string> {
  try {
    const { stdout } = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
      cwd: repoPath
    })
    return stdout.trim().replace(/^origin\//, '') || 'main'
  } catch {
    return 'main'
  }
}

export const KNOWN_AGENTS: AgentConfig[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    command: 'claude',
    args: [],
    resumeArgs: ['--continue'],
    waiting: 'claude-hooks'
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: [],
    resumeArgs: ['resume', '--last'],
    waiting: 'idle'
  },
  { id: 'gemini', label: 'Gemini', command: 'gemini', args: [], resumeArgs: [], waiting: 'idle' },
  {
    id: 'opencode',
    label: 'opencode',
    command: 'opencode',
    args: [],
    resumeArgs: ['--continue'],
    waiting: 'idle'
  }
]

async function onPath(command: string): Promise<boolean> {
  try {
    if (process.platform === 'win32') await resolveCommand(command, [])
    else await run('which', [command], { cwd: process.cwd() })
    return true
  } catch {
    return false
  }
}

export async function installedAgents(): Promise<AgentConfig[]> {
  const found: AgentConfig[] = []
  for (const a of KNOWN_AGENTS) if (await onPath(a.command)) found.push(a)
  return found
}

export async function writeStarterConfig(root: string): Promise<AppConfig> {
  let prefix = 'dev'
  try {
    const { stdout } = await run('git', ['config', '--global', 'user.email'], { cwd: root })
    prefix = stdout.trim().split('@')[0] || prefix
  } catch {
    // no global email: keep the default prefix
  }
  const agents = await installedAgents()
  const cfg: AppConfig = {
    root,
    branchPrefix: prefix,
    repos: await detectRepos(root),
    agents: agents.length ? agents : [KNOWN_AGENTS[0]],
    defaultAgent: (agents[0] ?? KNOWN_AGENTS[0]).id,
    extraChecks: []
  }
  saveConfig(cfg)
  return cfg
}

export async function detectRepos(root: string): Promise<RepoConfig[]> {
  const repos: RepoConfig[] = []
  for (const name of readdirSync(root)) {
    if (name.startsWith('.')) continue
    const path = join(root, name)
    try {
      if (!statSync(path).isDirectory() || !existsSync(join(path, '.git'))) continue
    } catch {
      continue
    }
    repos.push({
      name,
      path,
      trunk: await trunkOf(path),
      copyFiles: [],
      linkDirs: [],
      setup: []
    })
  }
  return repos
}
