import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  abortRebase,
  conflictChunks,
  continueRebase,
  rebaseState,
  resolveConflictFile,
  resolveFile,
  startRebase
} from '../src/main/core/rebase'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

let n = 0
/** Commits `content` to `file` on origin's main from a throwaway clone. */
function mainCommit(root: string, origin: string, file: string, content: string): void {
  const tmp = join(root, `main-${n++}`)
  git(root, 'clone', '-q', origin, tmp)
  git(tmp, 'config', 'user.email', 't@t')
  git(tmp, 'config', 'user.name', 't')
  writeFileSync(join(tmp, file), content)
  git(tmp, 'add', '.')
  git(tmp, 'commit', '-qm', `main: ${file}`)
  git(tmp, 'push', '-q', 'origin', 'main')
}

function branchCommit(wt: string, file: string, content: string, msg: string): void {
  writeFileSync(join(wt, file), content)
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', msg)
}

function setup(): { root: string; origin: string; wt: string } {
  const root = tempDir()
  const { origin, clone } = makeOriginAndClone(root, 'main', 'api')
  git(clone, 'checkout', '-q', '-b', 'feat')
  return { root, origin, wt: clone }
}

test('a rebase without conflicts replays the branch on top of main', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'feature.txt', 'f\n', 'feat: one')
  branchCommit(wt, 'feature2.txt', 'g\n', 'feat: two')
  mainCommit(root, origin, 'other.txt', 'o\n')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'done', replayed: 2 })
  expect(git(wt, 'log', '--format=%s', '-3')).toBe('feat: two\nfeat: one\nmain: other.txt')
  expect((await rebaseState(wt)).inProgress).toBe(false)
})

test('already up to date reports clean', async () => {
  const { wt } = setup()
  expect(await startRebase(wt, 'main')).toEqual({ status: 'clean' })
})

test('uncommitted work is refused and nothing moves', async () => {
  const { root, origin, wt } = setup()
  mainCommit(root, origin, 'other.txt', 'o\n')
  writeFileSync(join(wt, 'README.md'), 'dirty\n')
  const head = git(wt, 'rev-parse', 'HEAD')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'dirty' })
  expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
})

test('conflicts are listed with the step, then resolved and continued to the end', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  mainCommit(root, origin, 'README.md', 'main\n')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'conflicts' })
  const state = await rebaseState(wt)
  expect(state).toMatchObject({ inProgress: true, step: 1, total: 1, subject: 'feat: readme' })
  expect(state.conflicts).toEqual([{ path: 'README.md', kind: 'text' }])
  expect(readFileSync(join(wt, 'README.md'), 'utf8')).toContain('<<<<<<<')

  await resolveFile(wt, 'README.md', 'main\nbranch\n')
  expect((await rebaseState(wt)).conflicts).toEqual([])
  expect(await continueRebase(wt)).toEqual({ status: 'done' })
  expect((await rebaseState(wt)).inProgress).toBe(false)
  expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('main\nbranch\n')
})

test('a file deleted on main and changed on the branch can be kept or removed', async () => {
  const { root, origin, wt } = setup()
  writeFileSync(join(wt, 'gone.txt'), 'v1\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'add gone')
  git(wt, 'push', '-q', 'origin', 'feat:main')
  branchCommit(wt, 'gone.txt', 'v2\n', 'feat: edit gone')
  const tmp = join(root, 'del')
  git(root, 'clone', '-q', origin, tmp)
  git(tmp, 'config', 'user.email', 't@t')
  git(tmp, 'config', 'user.name', 't')
  git(tmp, 'rm', '-q', 'gone.txt')
  git(tmp, 'commit', '-qm', 'main: delete gone')
  git(tmp, 'push', '-q', 'origin', 'main')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'conflicts' })
  expect((await rebaseState(wt)).conflicts).toEqual([{ path: 'gone.txt', kind: 'deleted-by-main' }])
  await resolveFile(wt, 'gone.txt', null)
  expect(await continueRebase(wt)).toEqual({ status: 'done' })
  expect(git(wt, 'ls-files', 'gone.txt')).toBe('')
})

test('abort puts the branch back where it was', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  const head = git(wt, 'rev-parse', 'HEAD')
  mainCommit(root, origin, 'README.md', 'main\n')
  await startRebase(wt, 'main')
  await abortRebase(wt)
  expect((await rebaseState(wt)).inProgress).toBe(false)
  expect(git(wt, 'rev-parse', 'HEAD')).toBe(head)
})

test('a commit the resolution leaves empty is dropped and the rebase goes on', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  branchCommit(wt, 'feature.txt', 'f\n', 'feat: feature')
  mainCommit(root, origin, 'README.md', 'main\n')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'conflicts' })
  await resolveFile(wt, 'README.md', 'main\n')
  expect(await continueRebase(wt)).toEqual({ status: 'done' })
  expect(git(wt, 'log', '--format=%s', '-2')).toBe('feat: feature\nmain: README.md')
})

test('when git cannot continue for another reason, nothing is skipped', { timeout: 30000 }, async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  mainCommit(root, origin, 'README.md', 'main\n')
  await startRebase(wt, 'main')
  await resolveFile(wt, 'README.md', 'resolved\n')
  // A stale lock makes every git write fail, with no conflict to show.
  writeFileSync(join(wt, '.git', 'index.lock'), '')
  await expect(continueRebase(wt)).rejects.toThrow()
  rmSync(join(wt, '.git', 'index.lock'))
  expect((await rebaseState(wt)).inProgress).toBe(true)
  expect(readFileSync(join(wt, 'README.md'), 'utf8')).toBe('resolved\n')
})

test('an empty commit is not skipped while there are edits not added, so they survive', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'notes.txt', 'v1\n', 'feat: notes')
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  mainCommit(root, origin, 'README.md', 'main\n')
  expect(await startRebase(wt, 'main')).toEqual({ status: 'conflicts' })
  await resolveFile(wt, 'README.md', 'main\n')
  writeFileSync(join(wt, 'notes.txt'), 'edited by the agent\n')
  await expect(continueRebase(wt)).rejects.toThrow(/sin agregar/)
  expect(readFileSync(join(wt, 'notes.txt'), 'utf8')).toBe('edited by the agent\n')
})

test('keeping a binary file in a deleted/changed conflict keeps its exact bytes', async () => {
  const { root, origin, wt } = setup()
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0x00, 0x80])
  writeFileSync(join(wt, 'img.png'), bytes)
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'add img')
  git(wt, 'push', '-q', 'origin', 'feat:main')
  writeFileSync(join(wt, 'img.png'), Buffer.concat([bytes, Buffer.from([0x01])]))
  git(wt, 'commit', '-qam', 'feat: change img')
  const tmp = join(root, 'del-img')
  git(root, 'clone', '-q', origin, tmp)
  git(tmp, 'config', 'user.email', 't@t')
  git(tmp, 'config', 'user.name', 't')
  git(tmp, 'rm', '-q', 'img.png')
  git(tmp, 'commit', '-qm', 'main: delete img')
  git(tmp, 'push', '-q', 'origin', 'main')
  await startRebase(wt, 'main')
  await resolveConflictFile(wt, 'img.png', { keep: true })
  expect(readFileSync(join(wt, 'img.png')).equals(Buffer.concat([bytes, Buffer.from([0x01])]))).toBe(true)
})

test('choosing sides in a Latin-1 file keeps its bytes, and paths with accents work', async () => {
  const { root, origin, wt } = setup()
  const file = 'configuración.txt'
  writeFileSync(join(wt, file), Buffer.from('a\xf1o\n', 'latin1'))
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'add')
  git(wt, 'push', '-q', 'origin', 'feat:main')
  writeFileSync(join(wt, file), Buffer.from('rama \xe9\n', 'latin1'))
  git(wt, 'commit', '-qam', 'feat: change')
  const tmp = join(root, 'latin')
  git(root, 'clone', '-q', origin, tmp)
  git(tmp, 'config', 'user.email', 't@t')
  git(tmp, 'config', 'user.name', 't')
  writeFileSync(join(tmp, file), Buffer.from('main \xe1\n', 'latin1'))
  git(tmp, 'commit', '-qam', 'main: change')
  git(tmp, 'push', '-q', 'origin', 'main')
  await startRebase(wt, 'main')
  expect((await rebaseState(wt)).conflicts).toEqual([{ path: file, kind: 'text' }])
  const chunks = await conflictChunks(wt, file)
  expect(chunks.filter((c) => c.kind === 'conflict')).toHaveLength(1)
  await resolveConflictFile(wt, file, { choices: ['branch'], conflicts: 1 })
  // Line endings follow core.autocrlf on checkout; the accented byte must stay Latin-1.
  expect(readFileSync(join(wt, file)).toString('latin1').replace(/\r/g, '')).toBe('rama \xe9\n')
})

test('choices made on an older version of the file are refused', async () => {
  const { root, origin, wt } = setup()
  branchCommit(wt, 'README.md', 'branch\n', 'feat: readme')
  mainCommit(root, origin, 'README.md', 'main\n')
  await startRebase(wt, 'main')
  await expect(resolveConflictFile(wt, 'README.md', { choices: ['main', 'main'], conflicts: 2 })).rejects.toThrow()
  expect(readFileSync(join(wt, 'README.md'), 'utf8')).toContain('<<<<<<<')
})
