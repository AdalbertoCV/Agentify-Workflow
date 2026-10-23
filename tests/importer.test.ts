import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { adoptLooseWorktrees, scanLooseWorktrees } from '../src/main/core/importer'
import { readSessions } from '../src/main/core/store'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

test('groups loose worktrees by ticket number and adopts them once', async () => {
  const root = tempDir()
  const api = makeOriginAndClone(root, 'main', 'api').clone
  const web = makeOriginAndClone(root, 'main', 'web').clone
  git(api, 'worktree', 'add', '-q', '-b', 'a/eng-2959-x', join(root, 'wt-2959-django'), 'origin/main')
  git(web, 'worktree', 'add', '-q', '-b', 'a/eng-2959-y', join(root, 'wt-2959-vue'), 'origin/main')
  git(web, 'worktree', 'add', '-q', '-b', 'toolhub', join(root, 'wt-toolhub'), 'origin/main')
  const cfg: AppConfig = {
    root,
    branchPrefix: 'a',
    repos: ['api', 'web'].map((name) => ({
      name,
      path: join(root, name),
      trunk: 'main',
      copyFiles: [],
      linkDirs: [],
      setup: []
    })),
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }

  const found = await scanLooseWorktrees(cfg)
  const byId = Object.fromEntries(found.map((s) => [s.id, s]))
  expect(Object.keys(byId).sort()).toEqual(['eng-2959', 'wt-toolhub'])
  expect(byId['eng-2959'].repos.map((r) => r.name).sort()).toEqual(['api', 'web'])
  expect(byId['eng-2959'].imported).toBe(true)
  expect(byId['wt-toolhub'].repos).toHaveLength(1)

  expect(await adoptLooseWorktrees(cfg)).toBe(2)
  expect(readSessions(root)).toHaveLength(2)
  expect(await adoptLooseWorktrees(cfg)).toBe(0)
})
