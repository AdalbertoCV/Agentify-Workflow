import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ConfigError, normalizeRepo, saveConfig, type AppConfig, type RepoConfig } from './config'
import { run } from './proc'

export function onboardDir(root: string, name: string): string {
  return join(root, '.agentify', 'repos', name)
}

export async function startOnboarding(
  cfg: AppConfig,
  src: { cloneUrl?: string; path?: string }
): Promise<{ repoName: string; repoPath: string; workDir: string }> {
  let repoPath: string
  if (src.cloneUrl) {
    const name = basename(src.cloneUrl.replace(/\.git$/, '').replace(/[\\/]+$/, ''))
    repoPath = join(cfg.root, name)
    if (!existsSync(repoPath)) await run('git', ['clone', src.cloneUrl, repoPath], { cwd: cfg.root })
  } else if (src.path) {
    repoPath = src.path
  } else throw new Error('Pega una URL o elige una carpeta')
  if (!existsSync(join(repoPath, '.git'))) throw new Error(`${repoPath} no es un repo git`)
  const repoName = basename(repoPath)
  const workDir = onboardDir(cfg.root, repoName)
  mkdirSync(workDir, { recursive: true })
  return { repoName, repoPath, workDir }
}

export function onboardPrompt(
  repoName: string,
  repoPath: string,
  workDir: string,
  cfg: AppConfig
): string {
  const others = cfg.repos.filter((r) => r.name !== repoName).map((r) => r.name)
  const slash = (p: string): string => p.replace(/\\/g, '/')
  return [
    `You are setting up the repo "${repoName}" (${slash(repoPath)}) for Agentify, a tool that runs`,
    'each ticket in an isolated session (own git worktree, own database copy, own ports).',
    '',
    `Read the repo (README, AGENTS.md/CLAUDE.md, package.json/pyproject.toml, docker-compose files,`,
    '.env.example, settings) and figure out how a developer runs it locally. Then write these files',
    `in ${slash(workDir)}/ — do NOT modify the repo itself:`,
    '',
    '1. run.sh — a bash script (Git Bash on Windows) that starts the service in the FOREGROUND from',
    '   the current directory (the session worktree or a fresh trunk checkout). Contract:',
    '   - Listen on $AGENTIFY_PORT (bind 127.0.0.1 or localhost).',
    '   - Other repos of the session listen on $AGENTIFY_PORT_<REPO_NAME_UPPERCASE_WITH_UNDERSCORES>;',
    '     point this service at them (for a frontend, prefer a dev-server proxy to the backend so',
    '     CORS does not matter).',
    '   - If it uses a database, use $AGENTIFY_DB_NAME as the database name (never the default one).',
    '   - Never talk to production queues, buckets or URLs: use local or disabled equivalents.',
    '   - If it needs Docker, use `docker compose -p "agentify-$AGENTIFY_SESSION-' + repoName + '"` and',
    '     remap host ports to $AGENTIFY_PORT so sessions do not collide.',
    '   - Install nothing globally; assume dependencies were set up by the "setup" commands.',
    '2. stop.sh — only if run.sh starts something that outlives it (e.g. docker compose down).',
    '3. repo.json — exactly this shape:',
    '   {',
    `     "name": "${repoName}",`,
    '     "trunk": "<default branch on origin>",',
    '     "copyFiles": ["<gitignored files a fresh worktree needs, e.g. .env>"],',
    '     "linkDirs": ["<heavy gitignored dirs to share with the main checkout, e.g. node_modules>"],',
    '     "db": { "envFile": ".env", "nameKey": "DB_NAME", "userKey": "...", "passwordKey": "...",',
    '             "hostKey": "...", "portKey": "..." }   // only if it uses PostgreSQL',
    '     "setup": ["<commands run once in a new worktree, e.g. migrations>"],',
    `     "run": { "script": ".agentify/repos/${repoName}/run.sh", "stop": ".agentify/repos/${repoName}/stop.sh",`,
    '              "port": true, "needs": ["<other repos it calls>"], "url": "http://localhost:{port}/" }',
    '   }',
    '   Drop "stop" if there is no stop.sh and "url" if it is not the app the user opens in a browser.',
    others.length ? `   Other repos available for "needs": ${others.join(', ')}.` : '',
    '',
    'Write repo.json last: the app is watching for it. When you are done, summarize what you',
    'decided and anything the user should double-check.'
  ]
    .filter((l) => l !== '')
    .join('\n')
}

export function readOnboardResult(
  workDir: string,
  root: string
): { repo: RepoConfig; runScript: string; stopScript?: string } {
  const raw = JSON.parse(readFileSync(join(workDir, 'repo.json'), 'utf8'))
  const problems: string[] = []
  const repo = normalizeRepo(raw, root, problems)
  if (!raw.run?.script) problems.push(`${repo.name}: falta run.script`)
  if (!existsSync(join(workDir, 'run.sh'))) problems.push('Falta run.sh')
  if (problems.length) throw new ConfigError(problems)
  const stop = join(workDir, 'stop.sh')
  return {
    repo,
    runScript: readFileSync(join(workDir, 'run.sh'), 'utf8'),
    stopScript: existsSync(stop) ? readFileSync(stop, 'utf8') : undefined
  }
}

export function saveRepo(cfg: AppConfig, repo: RepoConfig): AppConfig {
  const repos = cfg.repos.some((r) => r.name === repo.name)
    ? cfg.repos.map((r) => (r.name === repo.name ? repo : r))
    : [...cfg.repos, repo]
  const next = { ...cfg, repos }
  saveConfig(next)
  return next
}
