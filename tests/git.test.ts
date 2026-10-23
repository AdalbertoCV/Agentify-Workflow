import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { addWorktree, branchState, fetchRepo, worktreeRisk } from '../src/main/core/git'
import { git, makeOriginAndClone, pushBranch, tempDir } from './helpers/git'

describe('addWorktree', () => {
  test('new branch starts at origin trunk', async () => {
    const dir = tempDir()
    const { clone } = makeOriginAndClone(dir)
    const wt = join(dir, 'wt')
    const r = await addWorktree(clone, wt, 'p/t-1-x', 'main')
    expect(r.createdBranch).toBe(true)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(git(clone, 'rev-parse', 'origin/main'))
    expect(git(wt, 'branch', '--show-current')).toBe('p/t-1-x')
  })

  test('branch that exists on origin is resumed, not recreated', async () => {
    const dir = tempDir()
    const { clone, origin } = makeOriginAndClone(dir)
    const sha = pushBranch(dir, origin, 'p/t-2-y')
    const wt = join(dir, 'wt')
    await fetchRepo(clone)
    expect(await branchState(clone, 'p/t-2-y')).toBe('remote')
    const r = await addWorktree(clone, wt, 'p/t-2-y', 'main')
    expect(r.createdBranch).toBe(false)
    expect(git(wt, 'rev-parse', 'HEAD')).toBe(sha)
  })

  test('existing local branch is reused', async () => {
    const dir = tempDir()
    const { clone } = makeOriginAndClone(dir)
    git(clone, 'branch', 'p/t-3-z')
    expect(await branchState(clone, 'p/t-3-z')).toBe('local')
    const r = await addWorktree(clone, join(dir, 'wt'), 'p/t-3-z', 'main')
    expect(r.createdBranch).toBe(false)
  })
})

describe('worktreeRisk', () => {
  test('clean, dirty and unpushed', async () => {
    const dir = tempDir()
    const { clone } = makeOriginAndClone(dir)
    const wt = join(dir, 'wt')
    await addWorktree(clone, wt, 'p/t-4', 'main')
    expect(await worktreeRisk(wt)).toEqual({ dirty: false, unpushed: 0 })
    writeFileSync(join(wt, 'new.txt'), 'x')
    expect((await worktreeRisk(wt)).dirty).toBe(true)
    git(wt, 'add', '.')
    git(wt, 'commit', '-qm', 'local')
    expect(await worktreeRisk(wt)).toEqual({ dirty: false, unpushed: 1 })
  })
})
