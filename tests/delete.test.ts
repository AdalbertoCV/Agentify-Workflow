import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { readSessions } from '../src/main/core/store'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

const dropped: string[] = []
vi.mock('../src/main/core/db', () => ({
  copyDatabase: vi.fn(async () => {}),
  cloneDatabase: vi.fn(async () => {}),
  databaseExists: vi.fn(async () => false),
  dropDatabase: vi.fn(async (_c: unknown, name: string) => {
    dropped.push(name)
  })
}))

const { createSession, deleteSession, sessionDir } = await import('../src/main/core/sessions')

function setup(): AppConfig {
  const root = tempDir()
  const a = makeOriginAndClone(root, 'main', 'api')
  const b = makeOriginAndClone(root, 'main', 'web')
  writeFileSync(
    join(a.clone, '.env'),
    'DB_NAME=mylocal\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=localhost\nDB_PORT=5432\n'
  )
  mkdirSync(join(b.clone, 'node_modules'))
  writeFileSync(join(b.clone, 'node_modules', 'keep.txt'), 'keep')
  return {
    root,
    branchPrefix: 'p',
    repos: [
      {
        name: 'api',
        path: a.clone,
        trunk: 'main',
        copyFiles: ['.env'],
        linkDirs: [],
        setup: [],
        db: {
          envFile: '.env',
          nameKey: 'DB_NAME',
          userKey: 'DB_USER',
          passwordKey: 'DB_PASSWORD',
          hostKey: 'DB_HOST',
          portKey: 'DB_PORT'
        }
      },
      { name: 'web', path: b.clone, trunk: 'main', copyFiles: [], linkDirs: ['node_modules'], setup: [] }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
}

beforeEach(() => {
  dropped.length = 0
})

describe('deleteSession', () => {
  test('clean session is removed completely without touching link targets or source db', async () => {
    const cfg = setup()
    await createSession(cfg, { ticket: 'T-1', title: 'x', repos: ['api', 'web'] }, () => {})
    const before = vi.fn(async () => {})
    const r = await deleteSession(cfg, 't-1', { force: false, beforeRemove: before })
    expect(r).toEqual({ status: 'deleted' })
    expect(before).toHaveBeenCalledOnce()
    expect(existsSync(sessionDir(cfg, 't-1'))).toBe(false)
    expect(git(join(cfg.root, 'api'), 'branch', '--list', 'p/t-1-x')).toBe('')
    expect(existsSync(join(cfg.root, 'web', 'node_modules', 'keep.txt'))).toBe(true)
    expect(readSessions(cfg.root)).toEqual([])
    expect(dropped).toEqual(['agentify_t_1'])
  })

  test('drops the extra db that Probar created for a repo outside the session', async () => {
    const cfg = setup()
    await createSession(cfg, { ticket: 'T-2', title: 'x', repos: ['web'] }, () => {})
    const { updateSession } = await import('../src/main/core/store')
    updateSession(cfg.root, 't-2', { extraDbs: [{ repo: 'api', db: 'agentify_t_2' }] })
    expect(await deleteSession(cfg, 't-2', { force: false })).toEqual({ status: 'deleted' })
    expect(dropped).toEqual(['agentify_t_2'])
  })

  test('a half-removed worktree (no .git) still deletes, without following its junction', async () => {
    const cfg = setup()
    await createSession(cfg, { ticket: 'T-3', title: 'x', repos: ['web'] }, () => {})
    const wt = join(sessionDir(cfg, 't-3'), 'web')
    rmSync(join(wt, '.git'))
    expect(await deleteSession(cfg, 't-3', { force: false })).toEqual({ status: 'deleted' })
    expect(existsSync(sessionDir(cfg, 't-3'))).toBe(false)
    expect(existsSync(join(cfg.root, 'web', 'node_modules', 'keep.txt'))).toBe(true)
  })

  test.skipIf(process.platform !== 'win32')(
    'programs running from the session that the app did not start are listed, then stopped on confirm',
    async () => {
      const cfg = setup()
      await createSession(cfg, { ticket: 'T-4', title: 'x', repos: ['web'] }, () => {})
      const wt = join(sessionDir(cfg, 't-4'), 'web')
      writeFileSync(join(wt, 'hold.js'), 'setInterval(() => {}, 1000)\n')
      // Started through a launcher that exits, like a dev server from another terminal: not in our tree.
      const { spawn } = await import('node:child_process')
      spawn('cmd.exe', ['/d', '/c', 'start', '""', '/b', process.execPath, join(wt, 'hold.js')], {
        cwd: wt,
        detached: true,
        stdio: 'ignore'
      }).unref()
      await new Promise((r) => setTimeout(r, 1500))
      const r = await deleteSession(cfg, 't-4', { force: false })
      expect(r.status).toBe('needs-confirm')
      if (r.status === 'needs-confirm') expect(r.processes.some((p) => p.cmd.includes('hold.js'))).toBe(true)
      expect(existsSync(wt)).toBe(true)
      expect(await deleteSession(cfg, 't-4', { force: true })).toEqual({ status: 'deleted' })
      expect(existsSync(sessionDir(cfg, 't-4'))).toBe(false)
    }
  )

  test('uncommitted work needs confirmation and nothing is touched', async () => {
    const cfg = setup()
    await createSession(cfg, { ticket: 'T-1', title: 'x', repos: ['web'] }, () => {})
    writeFileSync(join(sessionDir(cfg, 't-1'), 'web', 'wip.txt'), 'wip')
    const r = await deleteSession(cfg, 't-1', { force: false })
    expect(r.status).toBe('needs-confirm')
    if (r.status === 'needs-confirm') expect(r.risks[0]).toMatchObject({ repo: 'web', dirty: true })
    expect(existsSync(join(sessionDir(cfg, 't-1'), 'web', 'wip.txt'))).toBe(true)
    expect(readSessions(cfg.root)).toHaveLength(1)
    expect(await deleteSession(cfg, 't-1', { force: true })).toEqual({ status: 'deleted' })
    expect(existsSync(sessionDir(cfg, 't-1'))).toBe(false)
  })

  test('unpushed commits need confirmation', async () => {
    const cfg = setup()
    await createSession(cfg, { ticket: 'T-1', title: 'x', repos: ['web'] }, () => {})
    const wt = join(sessionDir(cfg, 't-1'), 'web')
    writeFileSync(join(wt, 'c.txt'), 'c')
    git(wt, 'add', 'c.txt')
    git(wt, 'commit', '-qm', 'c')
    const r = await deleteSession(cfg, 't-1', { force: false })
    expect(r).toEqual({
      status: 'needs-confirm',
      risks: [{ repo: 'web', dirty: false, unpushed: 1 }],
      processes: []
    })
  })
})
