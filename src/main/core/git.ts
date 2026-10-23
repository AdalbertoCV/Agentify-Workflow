import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { unlinkTopLevelLinks } from './links'
import { run } from './proc'

/** Parallel checkout + fs cache: `worktree add` of a big repo on Windows goes from ~7 s to ~2 s. */
export const FAST_CHECKOUT = ['-c', 'checkout.workers=0', '-c', 'core.fscache=true']

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd })
  return stdout.trim()
}

async function gitOk(cwd: string, ...args: string[]): Promise<boolean> {
  try {
    await run('git', args, { cwd })
    return true
  } catch {
    return false
  }
}

export async function fetchRepo(repoPath: string): Promise<void> {
  await git(repoPath, 'fetch', '--prune', 'origin')
}

export async function branchState(
  repoPath: string,
  branch: string
): Promise<'local' | 'remote' | 'none'> {
  if (await gitOk(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`))
    return 'local'
  if (await gitOk(repoPath, 'show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`))
    return 'remote'
  return 'none'
}

export async function addWorktree(
  repoPath: string,
  wtPath: string,
  branch: string,
  trunk: string
): Promise<{ createdBranch: boolean }> {
  const state = await branchState(repoPath, branch)
  if (state === 'local') {
    await git(repoPath, ...FAST_CHECKOUT, 'worktree', 'add', wtPath, branch)
    return { createdBranch: false }
  }
  if (state === 'remote') {
    await git(repoPath, ...FAST_CHECKOUT, 'worktree', 'add', '--track', '-b', branch, wtPath, `origin/${branch}`)
    return { createdBranch: false }
  }
  await git(repoPath, ...FAST_CHECKOUT, 'worktree', 'add', '--no-track', '-b', branch, wtPath, `origin/${trunk}`)
  return { createdBranch: true }
}

/**
 * An existing local or origin branch for this ticket (`<anything>/<id>` or `<anything>/<id>-…`),
 * preferring the user's prefix. Lets a session resume work on a ticket whose title changed.
 */
export async function findTicketBranch(
  repoPath: string,
  prefix: string,
  id: string
): Promise<string | undefined> {
  const out = await git(
    repoPath,
    'for-each-ref',
    '--format=%(refname)',
    'refs/heads',
    'refs/remotes/origin'
  )
  const esc = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(^|/)${esc}(-|$)`, 'i')
  const names = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((r) => r.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\/origin\//, ''))
    .filter((n) => n !== 'HEAD' && re.test(n))
  return names.find((n) => n.startsWith(`${prefix}/`)) ?? names[0]
}

/** `ignore`: paths the tool itself placed (copied env files, linked dirs); they are not work. */
export async function worktreeRisk(
  wtPath: string,
  ignore: string[] = []
): Promise<{ dirty: boolean; unpushed: number }> {
  const skip = new Set(ignore.map((p) => p.replace(/\\/g, '/').replace(/\/$/, '')))
  const status = (await git(wtPath, 'status', '--porcelain'))
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((l) => !skip.has(l.slice(3).replace(/^"|"$/g, '').replace(/\/$/, '')))
    .join('\n')
  const unpushed = Number(await git(wtPath, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin'))
  return { dirty: status.length > 0, unpushed }
}

export async function removeWorktree(repoPath: string, wtPath: string): Promise<void> {
  unlinkTopLevelLinks(wtPath)
  if (existsSync(join(wtPath, '.git'))) {
    // git can unregister the worktree and still fail to delete files (Windows locks, long paths).
    await git(repoPath, 'worktree', 'remove', '--force', wtPath).catch(() => {})
  }
  // Whatever is left is a plain folder; its links are already gone, so this cannot follow them.
  if (existsSync(wtPath)) {
    try {
      rmSync(wtPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
    } catch (e) {
      const reason = (e as Error).message.split(/\r?\n/)[0]
      throw new Error(`No pude borrar ${wtPath}: algún programa lo tiene abierto (${reason})`)
    }
  }
  await git(repoPath, 'worktree', 'prune')
}

export async function deleteLocalBranch(repoPath: string, branch: string): Promise<void> {
  if (await gitOk(repoPath, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`))
    await git(repoPath, 'branch', '-D', branch)
}

/** Main checkout that owns a linked worktree (for repos no longer in the config). */
export async function mainCheckoutOf(wtPath: string): Promise<string | undefined> {
  if (!existsSync(wtPath)) return undefined
  try {
    const common = await git(wtPath, 'rev-parse', '--path-format=absolute', '--git-common-dir')
    return common.replace(/[\\/]\.git$/, '')
  } catch {
    return undefined
  }
}

export type WorktreeEntry ={ path: string; branch?: string; head: string; main: boolean }

export async function listWorktrees(repoPath: string): Promise<WorktreeEntry[]> {
  const out = await git(repoPath, 'worktree', 'list', '--porcelain')
  const entries: WorktreeEntry[] = []
  for (const block of out.split(/\r?\n\r?\n/)) {
    const lines = block.split(/\r?\n/)
    const path = lines.find((l) => l.startsWith('worktree '))?.slice(9)
    if (!path) continue
    const branch = lines.find((l) => l.startsWith('branch '))?.slice(7).replace('refs/heads/', '')
    const head = lines.find((l) => l.startsWith('HEAD '))?.slice(5) ?? ''
    entries.push({ path, branch, head, main: entries.length === 0 })
  }
  return entries
}
