import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { commitAndPush } from '../src/main/core/commit'
import type { AppConfig } from '../src/main/core/config'
import { addWorktree } from '../src/main/core/git'
import type { Session } from '../src/main/core/store'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

function setup(branch = 'p/t-1-x'): { cfg: AppConfig; s: Session; wt: string; origin: string } {
  const root = tempDir()
  const { clone, origin } = makeOriginAndClone(root, 'main', 'api')
  const wt = join(root, 'wt')
  const cfg = {
    root,
    repos: [{ name: 'api', path: clone, trunk: 'main', copyFiles: ['.env'], linkDirs: [], setup: [] }]
  } as unknown as AppConfig
  const s = {
    id: 't-1',
    ticket: 'T-1',
    repos: [{ name: 'api', worktree: wt, branch, createdBranch: true }]
  } as unknown as Session
  return { cfg, s, wt, origin }
}

test('commits every change except tool-placed files and pushes the branch', async () => {
  const { cfg, s, wt, origin } = setup()
  await addWorktree(cfg.repos[0].path, wt, 'p/t-1-x', 'main')
  writeFileSync(join(wt, 'feature.txt'), 'x\n')
  writeFileSync(join(wt, '.env'), 'SECRET=1\n')
  const [r] = await commitAndPush(cfg, s, 'T-1 hace algo')
  expect(r).toMatchObject({ repo: 'api', committed: true, pushed: true })
  const remote = git(origin, 'log', '-1', '--format=%s', 'p/t-1-x')
  expect(remote).toBe('T-1 hace algo')
  const files = git(origin, 'ls-tree', '-r', '--name-only', 'p/t-1-x')
  expect(files).toContain('feature.txt')
  expect(files).not.toContain('.env')
})

test('nothing to commit and nothing to push is reported, not an error', async () => {
  const { cfg, s, wt } = setup()
  await addWorktree(cfg.repos[0].path, wt, 'p/t-1-x', 'main')
  const [r] = await commitAndPush(cfg, s, 'msg')
  expect(r).toMatchObject({ committed: false, pushed: false })
  expect(r.error).toBeUndefined()
})

test('refuses to push a protected branch', async () => {
  const { cfg, s, wt } = setup('develop')
  git(cfg.repos[0].path, 'worktree', 'add', '-q', '-b', 'develop', wt, 'origin/main')
  writeFileSync(join(wt, 'x.txt'), 'x\n')
  const [r] = await commitAndPush(cfg, s, 'msg')
  expect(r.error).toMatch(/develop/)
  expect(r.pushed).toBe(false)
})
