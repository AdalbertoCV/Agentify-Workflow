import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AppConfig, RepoConfig } from '../src/main/core/config'
import { createSession, sessionDir } from '../src/main/core/sessions'
import { slugify } from '../src/main/core/slug'
import { readSessions } from '../src/main/core/store'
import { git, makeOriginAndClone, pushBranch, tempDir } from './helpers/git'

function repo(root: string, name: string, extra: Partial<RepoConfig> = {}): RepoConfig {
  return {
    name,
    path: join(root, name),
    trunk: 'main',
    copyFiles: [],
    linkDirs: [],
    setup: [],
    ...extra
  }
}

function setup(): { root: string; cfg: AppConfig; origins: Record<string, string> } {
  const root = tempDir()
  const a = makeOriginAndClone(root, 'main', 'api')
  const b = makeOriginAndClone(root, 'main', 'web')
  writeFileSync(join(a.clone, '.env'), 'X=1\n')
  mkdirSync(join(b.clone, 'node_modules'))
  writeFileSync(join(b.clone, 'node_modules', 'keep.txt'), 'keep')
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    repos: [
      repo(root, 'api', { copyFiles: ['.env'], setup: ['echo ok > setup.txt'] }),
      repo(root, 'web', { linkDirs: ['node_modules'], setup: ['echo ok > setup.txt'] })
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  return { root, cfg, origins: { api: a.origin, web: b.origin } }
}

test('slugify strips accents and symbols', () => {
  expect(slugify('Rango reemplaza tolerancia escrita ¿ñ?')).toBe(
    'rango-reemplaza-tolerancia-escrita-n'
  )
})

describe('createSession', () => {
  test('creates worktrees, copies env, links dirs, runs setup and records it', async () => {
    const { root, cfg } = setup()
    const progress: string[] = []
    const s = await createSession(
      cfg,
      { ticket: 'T-1', title: 'Hola mundo', repos: ['api', 'web'] },
      (m) => progress.push(m)
    )
    const dir = sessionDir(cfg, 't-1')
    expect(s.id).toBe('t-1')
    expect(s.repos.map((r) => r.branch)).toEqual(['p/t-1-hola-mundo', 'p/t-1-hola-mundo'])
    expect(readFileSync(join(dir, 'api', '.env'), 'utf8')).toBe('X=1\n')
    expect(existsSync(join(dir, 'api', 'setup.txt'))).toBe(true)
    expect(existsSync(join(dir, 'web', 'setup.txt'))).toBe(true)
    expect(lstatSync(join(dir, 'web', 'node_modules')).isSymbolicLink()).toBe(true)
    expect(readSessions(root).map((x) => x.id)).toEqual(['t-1'])
    const agents = readFileSync(join(dir, 'AGENTS.md'), 'utf8')
    expect(agents).toContain('T-1')
    expect(agents).toContain('Hola mundo')
    expect(agents).toContain(join(dir, 'web'))
    expect(readFileSync(join(dir, 'CLAUDE.md'), 'utf8')).toBe('@AGENTS.md\n')
    expect(progress.length).toBeGreaterThan(0)
  })

  test('rejects a ticket that already has a session', async () => {
    const { root, cfg } = setup()
    await createSession(cfg, { ticket: 'T-1', title: 'a', repos: ['api'] }, () => {})
    const before = readFileSync(join(root, '.agentify', 'sessions.json'), 'utf8')
    await expect(
      createSession(cfg, { ticket: 'T-1', title: 'a', repos: ['api'] }, () => {})
    ).rejects.toThrow('La sesión t-1 ya existe')
    expect(readFileSync(join(root, '.agentify', 'sessions.json'), 'utf8')).toBe(before)
  })

  test('rolls back everything when a step fails', async () => {
    const { root, cfg } = setup()
    cfg.repos[1].setup = ['exit 3']
    await expect(
      createSession(cfg, { ticket: 'T-1', title: 'x', repos: ['api', 'web'] }, () => {})
    ).rejects.toThrow()
    expect(existsSync(join(root, '.worktrees', 't-1'))).toBe(false)
    expect(git(join(root, 'api'), 'branch', '--list', 'p/t-1-x')).toBe('')
    expect(git(join(root, 'web'), 'branch', '--list', 'p/t-1-x')).toBe('')
    expect(readSessions(root)).toEqual([])
    expect(existsSync(join(root, 'web', 'node_modules', 'keep.txt'))).toBe(true)
  })

  test('resumes an existing ticket branch and rollback keeps it', async () => {
    const { root, cfg, origins } = setup()
    pushBranch(root, origins.api, 'p/t-1-old-title')
    cfg.repos[0].setup = ['exit 1']
    await expect(
      createSession(cfg, { ticket: 'T-1', title: 'new title', repos: ['api'] }, () => {})
    ).rejects.toThrow()
    expect(git(join(root, 'api'), 'branch', '--list', 'p/t-1-old-title')).toContain(
      'p/t-1-old-title'
    )
    cfg.repos[0].setup = []
    const s = await createSession(
      cfg,
      { ticket: 'T-1', title: 'new title', repos: ['api'] },
      () => {}
    )
    expect(s.repos[0].branch).toBe('p/t-1-old-title')
    expect(s.repos[0].createdBranch).toBe(false)
  })
})
