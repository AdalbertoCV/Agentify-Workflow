import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'
import { parseConflicts, resolveConflicts, type Choice, type Chunk } from './conflicts'
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
  // -z prints paths raw (no quoting, no octal escapes for accents).
  for (const entry of (await git(wt, 'status', '--porcelain=v1', '-z')).split('\0')) {
    const code = entry.slice(0, 2)
    if (!/^(DD|AU|UD|UA|DU|AA|UU)$/.test(code)) continue
    conflicts.push({ path: entry.slice(3), kind: KINDS[code] ?? 'other' })
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

// Files are handled as latin1 strings: one char per byte, so any encoding (UTF-8, Latin-1, even
// stray binary) round-trips byte for byte. Markers are ASCII, so parsing is unaffected.
function readBytes(wt: string, path: string): string {
  return readFileSync(join(wt, path)).toString('latin1')
}

function forDisplay(bytes: string): string {
  return Buffer.from(bytes, 'latin1').toString('utf8')
}

/** The conflict blocks of a file, decoded for display. */
export async function conflictChunks(wt: string, path: string): Promise<Chunk[]> {
  if (!existsSync(join(wt, path))) return []
  return parseConflicts(readBytes(wt, path)).map((c) =>
    c.kind === 'text' ? { kind: 'text', text: forDisplay(c.text) } : { kind: 'conflict', main: forDisplay(c.main), branch: forDisplay(c.branch) }
  )
}

export type Resolution = { choices: Choice[]; conflicts: number } | { keep: true } | { remove: true }

/**
 * Resolves one conflicted file: keep it as it is on disk, remove it, or pick a side per block.
 * Choices are refused when the file no longer has the blocks they were made on.
 */
export async function resolveConflictFile(wt: string, path: string, how: Resolution): Promise<void> {
  if ('remove' in how) return resolveFile(wt, path, null)
  if ('keep' in how) {
    await git(wt, 'add', '--', path)
    return
  }
  const chunks = parseConflicts(readBytes(wt, path))
  if (chunks.filter((c) => c.kind === 'conflict').length !== how.conflicts)
    throw new Error('El archivo cambió desde que elegiste (¿lo tocó el agente?); vuelve a elegir.')
  writeFileSync(join(wt, path), Buffer.from(resolveConflicts(chunks, how.choices), 'latin1'))
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
    const empty = await git(wt, 'diff', '--cached', '--quiet', 'HEAD').then(
      () => true,
      () => false
    )
    if (!empty) throw failure
    // --skip resets the working tree: never with edits that were not added.
    const loose = (await git(wt, 'status', '--porcelain', '--untracked-files=all')).trim()
    if (loose)
      throw new Error(
        `Hay cambios sin agregar en ${loose
          .split(/\r?\n/)
          .map((l) => l.slice(3))
          .join(', ')}; agrégalos (git add) o descártalos antes de continuar.`
      )
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
