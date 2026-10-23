import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, expect, test, vi } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { makeOriginAndClone, pushBranch, tempDir } from './helpers/git'

const calls: string[] = []
const existing = new Set<string>()
vi.mock('../src/main/core/db', () => ({
  databaseExists: vi.fn(async (_c: unknown, n: string) => existing.has(n)),
  copyDatabase: vi.fn(async (_c: unknown, s: string, t: string) => {
    calls.push(`copy ${s}->${t}`)
    existing.add(t)
  }),
  createDatabase: vi.fn(async (_c: unknown, t: string) => {
    calls.push(`create ${t}`)
    existing.add(t)
  }),
  cloneDatabase: vi.fn(async (_c: unknown, s: string, t: string) => {
    calls.push(`clone ${s}->${t}`)
    existing.add(t)
  }),
  renameDatabase: vi.fn(async (_c: unknown, from: string, to: string) => {
    calls.push(`rename ${from}->${to}`)
    existing.delete(from)
    existing.add(to)
  }),
  dropDatabase: vi.fn(async (_c: unknown, n: string) => {
    calls.push(`drop ${n}`)
    existing.delete(n)
  })
}))

const { createSession } = await import('../src/main/core/sessions')
const { ensureGolden, goldenName, prepareSpare, cloneFromGolden, waitSpareRefill } = await import(
  '../src/main/core/golden'
)

function setup(): { cfg: AppConfig; origin: string } {
  const root = tempDir()
  const { clone, origin } = makeOriginAndClone(root, 'main', 'api')
  writeFileSync(join(clone, '.env'), 'DB_NAME=mylocal\nDB_USER=u\nDB_PASSWORD=p\nDB_HOST=localhost\nDB_PORT=5432\n')
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
        // Records which database each setup run targeted.
        setup: ['echo "$DB_NAME" >> "$AGENTIFY_ROOT/migrated.txt"'],
        db: {
          envFile: '.env',
          nameKey: 'DB_NAME',
          userKey: 'DB_USER',
          passwordKey: 'DB_PASSWORD',
          hostKey: 'DB_HOST',
          portKey: 'DB_PORT'
        }
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  return { cfg, origin }
}

beforeEach(() => {
  calls.length = 0
  existing.clear()
})

test('golden is copied from local once, migrated on trunk; sessions are cloned from it', async () => {
  const { cfg } = setup()
  const golden = goldenName('api')
  await createSession(cfg, { ticket: 'T-1', title: 'a', repos: ['api'] }, () => {})
  await waitSpareRefill()
  await createSession(cfg, { ticket: 'T-2', title: 'b', repos: ['api'] }, () => {})
  await waitSpareRefill()
  expect(calls).toEqual([
    `copy mylocal->${golden}`,
    `clone ${golden}->agentify_t_1`,
    `clone ${golden}->${golden}_spare`,
    `rename ${golden}_spare->agentify_t_2`,
    `clone ${golden}->${golden}_spare`
  ])
  const migrated = readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)
  // golden once (trunk), then each session on its own db (branch migrations)
  expect(migrated).toEqual([golden, 'agentify_t_1', 'agentify_t_2'])
})

test('golden re-migrates only when trunk moves, and re-copies only when asked', async () => {
  const { cfg, origin } = setup()
  const golden = goldenName('api')
  const log = (): void => {}
  await ensureGolden(cfg, cfg.repos[0], log)
  await ensureGolden(cfg, cfg.repos[0], log)
  expect(calls).toEqual([`copy mylocal->${golden}`])
  const migratedOnce = readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)
  expect(migratedOnce).toHaveLength(1)

  pushBranch(cfg.root, origin, 'main', 'main')
  await ensureGolden(cfg, cfg.repos[0], log)
  expect(calls).toEqual([`copy mylocal->${golden}`])
  expect(readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toHaveLength(2)

  await ensureGolden(cfg, cfg.repos[0], log, { recopy: true })
  expect(calls.slice(1)).toEqual([`drop ${golden}`, `copy mylocal->${golden}`])
})

test('empty source: golden is created blank, migrated and seeded once per trunk change', async () => {
  const { cfg, origin } = setup()
  const golden = goldenName('api')
  cfg.repos[0].db!.source = 'empty'
  cfg.repos[0].db!.seed = ['echo "seed $DB_NAME" >> "$AGENTIFY_ROOT/migrated.txt"']
  await ensureGolden(cfg, cfg.repos[0], () => {})
  await ensureGolden(cfg, cfg.repos[0], () => {})
  expect(calls).toEqual([`create ${golden}`])
  expect(readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toEqual([golden, `seed ${golden}`])

  // New trunk commit: only the new migrations run (a full rebuild takes many minutes).
  pushBranch(cfg.root, origin, 'main', 'main')
  await ensureGolden(cfg, cfg.repos[0], () => {})
  expect(calls).toEqual([`create ${golden}`])
  expect(readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toEqual([
    golden,
    `seed ${golden}`,
    golden
  ])

  // Asked explicitly: rebuilt from scratch and re-seeded.
  await ensureGolden(cfg, cfg.repos[0], () => {}, { recopy: true })
  expect(calls).toEqual([`create ${golden}`, `drop ${golden}`, `create ${golden}`])
})

test('session skips setup when its branch has the same migrations as the golden', async () => {
  const { cfg } = setup()
  const golden = goldenName('api')
  cfg.repos[0].db!.migrationPaths = ['migrations']
  await createSession(cfg, { ticket: 'T-5', title: 'a', repos: ['api'] }, () => {})
  await waitSpareRefill()
  // golden migrated once; the session reused it as is
  expect(readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toEqual([golden])
})

test('session runs setup when its branch adds migrations', async () => {
  const { cfg, origin } = setup()
  cfg.repos[0].db!.migrationPaths = ['migrations']
  const golden = goldenName('api')
  await ensureGolden(cfg, cfg.repos[0], () => {})
  // A ticket branch on origin that adds a migration file.
  const tmp = join(cfg.root, 'branch-src')
  execFileSync('git', ['clone', '-q', origin, tmp])
  execFileSync('git', ['-C', tmp, 'checkout', '-q', '-b', 'p/t-6-x'])
  mkdirSync(join(tmp, 'migrations'))
  writeFileSync(join(tmp, 'migrations', '0002_new.py'), '# new\n')
  execFileSync('git', ['-C', tmp, 'add', '.'])
  execFileSync('git', ['-C', tmp, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'mig'])
  execFileSync('git', ['-C', tmp, 'push', '-q', 'origin', 'p/t-6-x'])
  await createSession(cfg, { ticket: 'T-6', title: 'x', repos: ['api'] }, () => {})
  await waitSpareRefill()
  expect(readFileSync(join(cfg.root, 'migrated.txt'), 'utf8').trim().split(/\r?\n/)).toEqual([golden, 'agentify_t_6'])
})

test('sessions take a ready spare by renaming it, then a new spare is prepared', async () => {
  const { cfg } = setup()
  const golden = goldenName('api')
  const spare = `${golden}_spare`
  await ensureGolden(cfg, cfg.repos[0], () => {})
  await prepareSpare(cfg, cfg.repos[0])
  calls.length = 0

  await cloneFromGolden(cfg, cfg.repos[0], 'agentify_t_9')
  expect(calls[0]).toBe(`rename ${spare}->agentify_t_9`)
  await waitSpareRefill()
  expect(calls).toContain(`clone ${golden}->${spare}`)

  // Without a spare it falls back to a direct clone.
  existing.delete(spare)
  calls.length = 0
  await cloneFromGolden(cfg, cfg.repos[0], 'agentify_t_10')
  expect(calls[0]).toBe(`clone ${golden}->agentify_t_10`)
  await waitSpareRefill()
})

test('a golden that does not migrate explains it is the local database', async () => {
  const { cfg } = setup()
  cfg.repos[0].setup = ['echo "no existe la columna hours" >&2; exit 1']
  await expect(ensureGolden(cfg, cfg.repos[0], () => {})).rejects.toThrow(/Tu base local .* no migra contra main/)
})
