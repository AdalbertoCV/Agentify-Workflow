import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { sessionDiff } from '../src/main/core/diff'
import { addWorktree } from '../src/main/core/git'
import type { Session } from '../src/main/core/store'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

test('diff shows only what is not committed yet, and counts commits not pushed', async () => {
  const root = tempDir()
  const { clone } = makeOriginAndClone(root, 'main', 'api')
  const wt = join(root, 'wt')
  await addWorktree(clone, wt, 'p/t-1', 'main')
  writeFileSync(join(wt, 'committed.txt'), 'a\n')
  git(wt, 'add', '.')
  git(wt, 'commit', '-qm', 'c')
  writeFileSync(join(wt, 'README.md'), 'changed\n')
  writeFileSync(join(wt, 'brand-new.txt'), 'n\n')
  const cfg = {
    root,
    repos: [{ name: 'api', path: clone, trunk: 'main', copyFiles: [], linkDirs: [], setup: [] }]
  } as unknown as AppConfig
  const s = {
    id: 't-1',
    repos: [{ name: 'api', worktree: wt, branch: 'p/t-1', createdBranch: true }]
  } as unknown as Session
  const [d] = await sessionDiff(cfg, s)
  expect(d.repo).toBe('api')
  expect(d.files).toBe(2)
  expect(d.patch).toContain('README.md')
  expect(d.patch).toContain('brand-new.txt')
  expect(d.patch).not.toContain('committed.txt')
  expect(d.unpushed).toBe(1)
})
