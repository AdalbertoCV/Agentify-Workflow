import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppConfig, RepoConfig } from './config'
import { FAST_CHECKOUT } from './git'
import { isLink, linkDir, removeLink } from './links'
import { run, runShell } from './proc'

export function trunkDir(cfg: AppConfig, repo: string): string {
  return join(cfg.root, '.agentify', 'trunk', repo)
}

function hasContent(dir: string): boolean {
  return existsSync(dir) && readdirSync(dir).some((n) => !n.startsWith('.'))
}

/** Where a session's `linkDirs` point: the app's fresh-trunk copy, or the user's main checkout. */
export function linkSource(cfg: AppConfig, repo: RepoConfig): string {
  return repo.linkFrom === 'trunk' ? trunkDir(cfg, repo.name) : repo.path
}

async function watchedHash(dir: string, watch: string[]): Promise<string> {
  const { stdout } = await run('git', ['rev-parse', ...watch.map((w) => `HEAD:${w}`)], { cwd: dir }).catch(
    () => ({ stdout: '' })
  )
  return stdout.trim().replace(/\s+/g, ',')
}

/**
 * Installs dependencies in the trunk copy when the watched files (lockfiles) changed on main.
 * A copy that already has its dependencies (installed by hand) is adopted as is.
 */
async function ensureInstalled(
  cfg: AppConfig,
  repo: RepoConfig,
  dir: string,
  log: (msg: string) => void
): Promise<void> {
  if (!repo.install) return
  const stateFile = `${dir}.install.json`
  const hash = await watchedHash(dir, repo.install.watch)
  const state = existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : {}
  const installed = repo.linkDirs.every((d) => hasContent(join(dir, d)))
  if (installed && (state.hash === hash || state.hash === undefined)) {
    if (state.hash === undefined) writeFileSync(stateFile, JSON.stringify({ hash }))
    return
  }
  log(`${repo.name}: instalando dependencias de ${repo.trunk} (${repo.install.command}); sólo cuando cambian…`)
  await runShell(repo.install.command, { cwd: dir, env: { AGENTIFY_ROOT: cfg.root } })
  log(`${repo.name}: dependencias listas`)
  writeFileSync(stateFile, JSON.stringify({ hash }))
}

/**
 * A detached worktree at the freshest origin/<trunk>, owned by the app, so repos a ticket
 * does not touch can run from main without moving the user's own checkout.
 */
export async function ensureTrunkWorktree(
  cfg: AppConfig,
  repo: RepoConfig,
  refresh = true,
  log: (msg: string) => void = () => {}
): Promise<string> {
  const dir = trunkDir(cfg, repo.name)
  const git = (cwd: string, ...args: string[]): Promise<unknown> => run('git', args, { cwd })
  if (refresh || !existsSync(dir)) await git(repo.path, 'fetch', '--prune', 'origin')
  if (!existsSync(dir)) {
    mkdirSync(dirname(dir), { recursive: true })
    await git(repo.path, ...FAST_CHECKOUT, 'worktree', 'add', '--detach', dir, `origin/${repo.trunk}`)
  } else if (refresh) {
    await git(dir, 'checkout', '--detach', '--force', `origin/${repo.trunk}`)
    await git(dir, 'reset', '--hard', `origin/${repo.trunk}`)
  }
  for (const f of repo.copyFiles) {
    const src = join(repo.path, f)
    if (existsSync(src)) {
      mkdirSync(dirname(join(dir, f)), { recursive: true })
      copyFileSync(src, join(dir, f))
    }
  }
  if (repo.linkFrom === 'trunk') {
    // The trunk copy owns the real dependency folders; sessions link to it.
    await ensureInstalled(cfg, repo, dir, log)
  } else {
    for (const d of repo.linkDirs) {
      const target = join(repo.path, d)
      if (existsSync(target) && !existsSync(join(dir, d))) linkDir(target, join(dir, d))
    }
  }
  return dir
}

/**
 * Old worktrees may link their dependency dirs to an empty main checkout: point those links at
 * the installed trunk copy instead. Only links are touched, never real folders.
 */
export async function relinkEmptyDirs(
  cfg: AppConfig,
  repo: RepoConfig,
  cwd: string,
  log: (msg: string) => void = () => {}
): Promise<void> {
  if (repo.linkFrom !== 'trunk') return
  for (const d of repo.linkDirs) {
    const p = join(cwd, d)
    if (hasContent(p)) continue
    if (existsSync(p) && !isLink(p)) continue
    const trunk = await ensureTrunkWorktree(cfg, repo, false, log)
    if (!hasContent(join(trunk, d))) continue
    if (existsSync(p) || isLink(p)) removeLink(p)
    linkDir(join(trunk, d), p)
  }
}
