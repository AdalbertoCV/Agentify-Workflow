import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { makeOriginAndClone, tempDir } from './helpers/git'

const calls: string[] = []
const existing = new Set<string>()
vi.mock('../src/main/core/db', () => ({
  databaseExists: vi.fn(async (_c: unknown, n: string) => existing.has(n)),
  copyDatabase: vi.fn(async () => {}),
  createDatabase: vi.fn(async (_c: unknown, t: string) => {
    calls.push(`create ${t}`)
    existing.add(t)
  }),
  cloneDatabase: vi.fn(async (_c: unknown, s: string, t: string) => {
    calls.push(`clone ${s}->${t}`)
    existing.add(t)
  }),
  renameDatabase: vi.fn(async (_c: unknown, f: string, t: string) => {
    calls.push(`rename ${f}->${t}`)
    existing.delete(f)
    existing.add(t)
  }),
  dropDatabase: vi.fn(async (_c: unknown, n: string) => {
    calls.push(`drop ${n}`)
    existing.delete(n)
  })
}))

const { Runner } = await import('../src/main/core/runner')
const { waitSpareRefill, goldenName } = await import('../src/main/core/golden')
const { writeSessions } = await import('../src/main/core/store')

const SERVE = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.AGENTIFY_PORT,'127.0.0.1')"`

beforeEach(() => {
  calls.length = 0
  existing.clear()
})

test('a stale session db that does not migrate is recreated from the golden', async () => {
  const root = tempDir()
  const { clone } = makeOriginAndClone(root, 'main', 'api')
  writeFileSync(join(clone, '.env'), 'DB_NAME=mylocal\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=localhost\nDB_PORT=5432\n')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'serve.sh'), `${SERVE}\n`)
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    repos: [
      {
        name: 'api',
        path: clone,
        trunk: 'main',
        copyFiles: ['.env'],
        linkDirs: [],
        // Fails on the stale db, works on a fresh clone; records each db it ran on.
        setup: [
          'echo "$DB_NAME" >> "$AGENTIFY_ROOT/migrated.txt"; [ "$DB_NAME" != agentify_t_7 ] || [ -f "$AGENTIFY_ROOT/fresh" ] || exit 1'
        ],
        db: {
          envFile: '.env',
          nameKey: 'DB_NAME',
          userKey: 'DB_USER',
          passwordKey: 'DB_PASSWORD',
          hostKey: 'DB_HOST',
          portKey: 'DB_PORT',
          source: 'empty'
        },
        run: { script: 'scripts/serve.sh', port: true }
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  // Imported session: the repo is in the session (its own worktree) but has no db of its own yet,
  // and a stale db from an older version exists under the session name.
  const session = {
    id: 't-7',
    ticket: 'T-7',
    title: 'x',
    agent: 'claude',
    createdAt: '',
    imported: true,
    repos: [{ name: 'api', worktree: clone, branch: 'main', createdBranch: false }],
    extraDbs: [{ repo: 'api', db: 'agentify_t_7' }]
  }
  writeSessions(root, [session])
  existing.add('agentify_t_7')
  const dropDb = calls
  const runner = new Runner()
  // The recreated db must be the one that migrates: mark "fresh" once the stale one is dropped.
  const origPush = dropDb.push.bind(dropDb)
  dropDb.push = (...items: string[]): number => {
    if (items.some((i) => i === 'drop agentify_t_7')) writeFileSync(join(root, 'fresh'), '')
    return origPush(...items)
  }
  await runner.start(cfg, session, () => {})
  await runner.stop('t-7')
  await waitSpareRefill()
  const golden = goldenName('api')
  expect(calls).toContain('drop agentify_t_7')
  expect(calls.indexOf('drop agentify_t_7')).toBeLessThan(
    calls.findIndex((c) => c.endsWith('->agentify_t_7'))
  )
  const migrated = readFileSync(join(root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)
  expect(migrated).toEqual([golden, 'agentify_t_7', 'agentify_t_7'])
})

test('Probar migrates the session db of a repo in the session, so new migrations of the branch apply', async () => {
  const root = tempDir()
  const { clone } = makeOriginAndClone(root, 'main', 'api')
  writeFileSync(join(clone, '.env'), 'DB_NAME=mylocal\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=localhost\nDB_PORT=5432\n')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'serve.sh'), `${SERVE}\n`)
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    repos: [
      {
        name: 'api',
        path: clone,
        trunk: 'main',
        copyFiles: ['.env'],
        linkDirs: [],
        setup: ['echo "$DB_NAME" >> "$AGENTIFY_ROOT/migrated.txt"'],
        db: {
          envFile: '.env',
          nameKey: 'DB_NAME',
          userKey: 'DB_USER',
          passwordKey: 'DB_PASSWORD',
          hostKey: 'DB_HOST',
          portKey: 'DB_PORT',
          source: 'empty'
        },
        run: { script: 'scripts/serve.sh', port: true }
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  const session = {
    id: 't-8',
    ticket: 'T-8',
    title: 'x',
    agent: 'claude',
    createdAt: '',
    imported: false,
    repos: [{ name: 'api', worktree: clone, branch: 'main', createdBranch: false, db: 'agentify_t_8' }]
  }
  writeSessions(root, [session])
  existing.add('agentify_t_8')
  const runner = new Runner()
  await runner.start(cfg, session, () => {})
  await runner.stop('t-8')
  expect(readFileSync(join(root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toEqual(['agentify_t_8'])
})

test('Probar migrates again only when the migration files changed, committed or not', async () => {
  const root = tempDir()
  const { clone } = makeOriginAndClone(root, 'main', 'api')
  writeFileSync(join(clone, '.env'), 'DB_NAME=mylocal\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=localhost\nDB_PORT=5432\n')
  mkdirSync(join(clone, 'migrations'))
  writeFileSync(join(clone, 'migrations', '0001_initial.py'), '# 1\n')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'serve.sh'), `${SERVE}\n`)
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    repos: [
      {
        name: 'api',
        path: clone,
        trunk: 'main',
        copyFiles: ['.env'],
        linkDirs: [],
        setup: ['echo "$DB_NAME" >> "$AGENTIFY_ROOT/migrated.txt"'],
        db: {
          envFile: '.env',
          nameKey: 'DB_NAME',
          userKey: 'DB_USER',
          passwordKey: 'DB_PASSWORD',
          hostKey: 'DB_HOST',
          portKey: 'DB_PORT',
          source: 'empty',
          migrationPaths: ['migrations/*.py']
        },
        run: { script: 'scripts/serve.sh', port: true }
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  const session = {
    id: 't-9',
    ticket: 'T-9',
    title: 'x',
    agent: 'claude',
    createdAt: '',
    imported: false,
    repos: [{ name: 'api', worktree: clone, branch: 'main', createdBranch: false, db: 'agentify_t_9' }]
  }
  writeSessions(root, [session])
  existing.add('agentify_t_9')
  const runner = new Runner()
  const probar = async (): Promise<number> => {
    await runner.start(cfg, session, () => {})
    await runner.stop('t-9')
    return readFileSync(join(root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/).length
  }
  expect(await probar()).toBe(1)
  expect(await probar()).toBe(1)
  writeFileSync(join(clone, 'migrations', '0002_new.py'), '# 2\n')
  expect(await probar()).toBe(2)
  expect(await probar()).toBe(2)
})
