import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { addWorktree, removeWorktree } from '../src/main/core/git'
import { linkDir, unlinkTopLevelLinks } from '../src/main/core/links'
import { makeOriginAndClone, tempDir } from './helpers/git'

test('removing a worktree keeps the junction target intact', async () => {
  const dir = tempDir()
  const { clone } = makeOriginAndClone(dir)
  const target = join(dir, 'shared_modules')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'keep')
  const wt = join(dir, 'wt')
  await addWorktree(clone, wt, 'p/t-1', 'main')
  linkDir(target, join(wt, 'node_modules'))
  expect(existsSync(join(wt, 'node_modules', 'keep.txt'))).toBe(true)
  await removeWorktree(clone, wt)
  expect(existsSync(wt)).toBe(false)
  expect(existsSync(join(target, 'keep.txt'))).toBe(true)
})

test('unlinkTopLevelLinks removes only links', () => {
  const dir = tempDir()
  const target = join(dir, 'target')
  const work = join(dir, 'work')
  mkdirSync(target)
  writeFileSync(join(target, 'keep.txt'), 'keep')
  mkdirSync(join(work, 'src'), { recursive: true })
  linkDir(target, join(work, 'node_modules'))
  expect(unlinkTopLevelLinks(work)).toEqual(['node_modules'])
  expect(existsSync(join(work, 'src'))).toBe(true)
  expect(existsSync(join(work, 'node_modules'))).toBe(false)
  expect(existsSync(join(target, 'keep.txt'))).toBe(true)
})
