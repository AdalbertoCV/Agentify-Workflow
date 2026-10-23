import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { run } from './proc'

export type ConflictFile = { path: string; kind: 'text' | 'deleted-by-main' | 'deleted-by-branch' | 'other' }
export type RebaseState = {
  inProgress: boolean
  step?: number
  total?: number
  subject?: string
  conflicts: ConflictFile[]
}

// Never open an editor for commit messages: the app has no terminal for it.
const NO_EDITOR = { GIT_EDITOR: 'true', GIT_SEQUENCE_EDITOR: 'true' }

async function git(wt: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd: wt, env: NO_EDITOR })).stdout
}

async function gitPath(wt: string, name: string): Promise<string> {
  const p = (await git(wt, 'rev-parse', '--git-path', name)).trim()
  return isAbsolute(p) ? p : join(wt, p)
}

function readTrim(file: string): string | undefined {
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : undefined
}

// In a rebase "us" is main (HEAD) and "them" is the branch commit being replayed.
const KINDS: Record<string, ConflictFile['kind']> = {
  UU: 'text',
  AA: 'text',
  DU: 'deleted-by-main',
  UD: 'deleted-by-branch'
}

export async function rebaseState(wt: string): Promise<RebaseState> {
  const merge = await gitPath(wt, 'rebase-merge')
  const apply = await gitPath(wt, 'rebase-apply')
  const dir = existsSync(merge) ? merge : existsSync(apply) ? apply : null
  if (!dir) return { inProgress: false, conflicts: [] }
  const step = Number(readTrim(join(dir, 'msgnum')) ?? readTrim(join(dir, 'next')))
  const total = Number(readTrim(join(dir, 'end')) ?? readTrim(join(dir, 'last')))
  const subject = readTrim(join(dir, 'message'))?.split(/\r?\n/)[0]
  const conflicts: ConflictFile[] = []
  for (const line of (await git(wt, 'status', '--porcelain=v1')).split(/\r?\n/)) {
    const code = line.slice(0, 2)
    if (!/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) continue
    conflicts.push({ path: line.slice(3).replace(/^"(.*)"$/, '$1'), kind: KINDS[code] ?? 'other' })
  }
  return { inProgress: true, step: step || undefined, total: total || undefined, subject, conflicts }
}

/** Fetches and rebases the branch onto origin/<trunk>. Refuses uncommitted work (besides `placed` files). */
export async function startRebase(
  wt: string,
  trunk: string,
  placed: string[] = []
): Promise<{ status: 'clean' | 'dirty' | 'conflicts' | 'done'; replayed?: number }> {
  const status = await git(wt, 'status', '--porcelain', '--', '.', ...placed.map((p) => `:(exclude)${p}`))
  if (status.trim()) return { status: 'dirty' }
  await git(wt, 'fetch', 'origin', trunk)
  const upstream = `origin/${trunk}`
  try {
    await git(wt, 'merge-base', '--is-ancestor', upstream, 'HEAD')
    return { status: 'clean' }
  } catch {
    // behind main: rebase below
  }
  const replayed = Number((await git(wt, 'rev-list', '--count', `${upstream}..HEAD`)).trim())
  try {
    await git(wt, 'rebase', upstream)
  } catch (e) {
    if ((await rebaseState(wt)).inProgress) return { status: 'conflicts' }
    throw e
  }
  return { status: 'done', replayed }
}

/** Writes the resolved content and stages it; null removes the file. */
export async function resolveFile(wt: string, path: string, content: string | null): Promise<void> {
  if (content === null) {
    await git(wt, 'rm', '-q', '--ignore-unmatch', '--', path)
    return
  }
  mkdirSync(dirname(join(wt, path)), { recursive: true })
  writeFileSync(join(wt, path), content)
  await git(wt, 'add', '--', path)
}

export async function continueRebase(wt: string): Promise<{ status: 'conflicts' | 'done' }> {
  for (;;) {
    let failure: unknown
    try {
      await git(wt, 'rebase', '--continue')
    } catch (e) {
      failure = e
    }
    const state = await rebaseState(wt)
    if (!state.inProgress) return { status: 'done' }
    if (state.conflicts.length) return { status: 'conflicts' }
    if (!failure) continue
    // Only a commit the resolution left empty may be dropped; any other failure is the user's to see.
    let empty = false
    try {
      await git(wt, 'diff', '--cached', '--quiet', 'HEAD')
      empty = true
    } catch {
      empty = false
    }
    if (!empty) throw failure
    try {
      await git(wt, 'rebase', '--skip')
    } catch (e) {
      const after = await rebaseState(wt)
      if (after.inProgress && !after.conflicts.length) throw e
    }
    const after = await rebaseState(wt)
    if (!after.inProgress) return { status: 'done' }
    if (after.conflicts.length) return { status: 'conflicts' }
  }
}

export async function abortRebase(wt: string): Promise<void> {
  await git(wt, 'rebase', '--abort')
}
