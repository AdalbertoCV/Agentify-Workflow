import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { createSession, sessionDir } from '../src/main/core/sessions'
import { ensureTrunkWorktree, trunkDir } from '../src/main/core/trunk'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

function setup(): { cfg: AppConfig; origin: string } {
  const root = tempDir()
  const { clone, origin } = makeOriginAndClone(root, 'main', 'web')
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    repos: [
      {
        name: 'web',
        path: clone,
        trunk: 'main',
        copyFiles: [],
        linkDirs: ['node_modules'],
        linkFrom: 'trunk',
        // Fake install: creates node_modules and logs each run.
        install: { command: 'mkdir -p node_modules && echo x > node_modules/pkg && echo run >> "$AGENTIFY_ROOT/installs.txt"', watch: ['README.md'] },
        setup: []
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  return { cfg, origin }
}

const installs = (cfg: AppConfig): number =>
  existsSync(join(cfg.root, 'installs.txt'))
    ? readFileSync(join(cfg.root, 'installs.txt'), 'utf8').trim().split(/\r?\n/).length
    : 0

test('trunk installs once and again only when a watched file changes on main', async () => {
  const { cfg, origin } = setup()
  await ensureTrunkWorktree(cfg, cfg.repos[0])
  await ensureTrunkWorktree(cfg, cfg.repos[0])
  expect(installs(cfg)).toBe(1)
  expect(existsSync(join(trunkDir(cfg, 'web'), 'node_modules', 'pkg'))).toBe(true)

  const tmp = join(cfg.root, 'pusher')
  git(cfg.root, 'clone', '-q', origin, tmp)
  writeFileSync(join(tmp, 'README.md'), 'deps changed\n')
  git(tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qam', 'deps')
  git(tmp, 'push', '-q', 'origin', 'main')
  await ensureTrunkWorktree(cfg, cfg.repos[0])
  expect(installs(cfg)).toBe(2)
})

test('an already installed trunk is adopted without reinstalling', async () => {
  const { cfg } = setup()
  cfg.repos[0].install = undefined
  const dir = await ensureTrunkWorktree(cfg, cfg.repos[0])
  writeFileSync(join(dir, 'node_modules-marker'), '')
  git(dir, 'status') // trunk exists
  cfg.repos[0].install = { command: 'echo run >> "$AGENTIFY_ROOT/installs.txt"', watch: ['README.md'] }
  // node_modules present (made by hand) → recorded, not reinstalled
  const { mkdirSync } = await import('node:fs')
  mkdirSync(join(dir, 'node_modules'))
  writeFileSync(join(dir, 'node_modules', 'pkg'), 'x')
  await ensureTrunkWorktree(cfg, cfg.repos[0])
  expect(installs(cfg)).toBe(0)
})

test('Probar relinks an empty link (old worktree) to the installed trunk copy', async () => {
  const { cfg } = setup()
  const { mkdirSync } = await import('node:fs')
  const { linkDir } = await import('../src/main/core/links')
  const { relinkEmptyDirs } = await import('../src/main/core/trunk')
  const wt = join(cfg.root, 'old-wt')
  mkdirSync(wt)
  const emptyMain = join(cfg.root, 'empty-main-modules')
  mkdirSync(emptyMain)
  linkDir(emptyMain, join(wt, 'node_modules'))
  await relinkEmptyDirs(cfg, cfg.repos[0], wt)
  expect(readFileSync(join(wt, 'node_modules', 'pkg'), 'utf8').trim()).toBe('x')
  expect(existsSync(emptyMain)).toBe(true)
})

test('sessions link their node_modules to the trunk copy, not the main checkout', async () => {
  const { cfg } = setup()
  await createSession(cfg, { ticket: 'T-1', title: 'x', repos: ['web'] }, () => {})
  const link = join(sessionDir(cfg, 't-1'), 'web', 'node_modules')
  expect(lstatSync(link).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(link, 'pkg'), 'utf8').trim()).toBe('x')
  expect(existsSync(join(cfg.repos[0].path, 'node_modules'))).toBe(false)
})
