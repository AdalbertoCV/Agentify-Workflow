import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, RepoConfig } from './config'
import { cloneDatabase, copyDatabase, createDatabase, databaseExists, dropDatabase, renameDatabase } from './db'
import { run, runShell } from './proc'
import { dbSource } from './sessions'
import { ensureTrunkWorktree } from './trunk'

/**
 * The "golden" database of a repo, already migrated to the freshest trunk: either a copy of the
 * developer's local database or a blank one plus seed data (`db.source: 'empty'`). Sessions clone
 * it with `createdb -T`, which takes seconds; copying a live database takes minutes and cannot
 * use a template while the local app is connected to it.
 */
export function goldenName(repo: string): string {
  return `agentify_golden_${repo.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`
}

type GoldenState = { copiedAt?: string; migratedSha?: string }

function stateFile(cfg: AppConfig, repo: string): string {
  return join(cfg.root, '.agentify', 'golden', `${repo}.json`)
}

function readState(cfg: AppConfig, repo: string): GoldenState {
  const f = stateFile(cfg, repo)
  return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}
}

function writeState(cfg: AppConfig, repo: string, s: GoldenState): void {
  mkdirSync(join(cfg.root, '.agentify', 'golden'), { recursive: true })
  writeFileSync(stateFile(cfg, repo), JSON.stringify(s, null, 2))
}

export function goldenCopiedAt(cfg: AppConfig, repo: string): Date | undefined {
  const at = readState(cfg, repo).copiedAt
  return at ? new Date(at) : undefined
}

const inflight = new Map<string, Promise<string>>()

export type GoldenOptions = { recopy?: boolean; refreshTrunk?: boolean }

/** Ready-to-clone golden db for `repo`. Concurrent callers share one refresh. */
export function ensureGolden(
  cfg: AppConfig,
  repo: RepoConfig,
  log: (msg: string) => void,
  opts: GoldenOptions = {}
): Promise<string> {
  const key = `${cfg.root}|${repo.name}`
  const previous = inflight.get(key)
  const next = (previous ?? Promise.resolve(''))
    .catch(() => '')
    .then(() => refreshGolden(cfg, repo, log, opts))
  inflight.set(key, next)
  void next.finally(() => inflight.get(key) === next && inflight.delete(key)).catch(() => {})
  return next
}

async function refreshGolden(
  cfg: AppConfig,
  repo: RepoConfig,
  log: (msg: string) => void,
  opts: GoldenOptions
): Promise<string> {
  const { conn, source } = dbSource(repo)
  const name = goldenName(repo.name)
  if (repo.db!.source === 'empty') return refreshEmptyGolden(cfg, repo, log, opts, conn, name)
  let state = readState(cfg, repo.name)

  if (opts.recopy || !state.copiedAt || !(await databaseExists(conn, name))) {
    await dropSpare(conn, name)
    if (await databaseExists(conn, name)) await dropDatabase(conn, name)
    log(`${repo.name}: copiando tu base local ${source} (sólo esta vez; las sesiones la clonan en segundos)…`)
    await copyDatabase(conn, source, name)
    state = { copiedAt: new Date().toISOString() }
    writeState(cfg, repo.name, state)
  }

  const trunk = await ensureTrunkWorktree(cfg, repo, opts.refreshTrunk ?? true)
  const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: trunk })).stdout.trim()
  if (state.migratedSha !== sha) {
    await dropSpare(conn, name)
    log(`${repo.name}: aplicando migraciones de ${repo.trunk} a la base madre…`)
    try {
      for (const line of repo.setup) {
        await runShell(line, {
          cwd: trunk,
          env: { [repo.db!.nameKey]: name, AGENTIFY_DB_NAME: name, AGENTIFY_ROOT: cfg.root }
        })
      }
    } catch (e) {
      throw new Error(
        `Tu base local (${source}) no migra contra ${repo.trunk}: seguramente tiene migraciones de otra rama. ` +
          `Arréglala y usa "Recopiar mi base local" en Repos.\n${(e as Error).message}`
      )
    }
    state = { ...state, migratedSha: sha }
    writeState(cfg, repo.name, state)
  }
  return name
}

function dbEnv(cfg: AppConfig, repo: RepoConfig, name: string): Record<string, string> {
  return { [repo.db!.nameKey]: name, AGENTIFY_DB_NAME: name, AGENTIFY_ROOT: cfg.root }
}

/**
 * Blank db + trunk migrations + seed, built once (a full migrate from zero takes minutes).
 * When trunk moves only the new migrations run; a rebuild happens only when asked.
 */
async function refreshEmptyGolden(
  cfg: AppConfig,
  repo: RepoConfig,
  log: (msg: string) => void,
  opts: GoldenOptions,
  conn: Parameters<typeof createDatabase>[0],
  name: string
): Promise<string> {
  const state = readState(cfg, repo.name)
  const trunk = await ensureTrunkWorktree(cfg, repo, opts.refreshTrunk ?? true)
  const sha = (await run('git', ['rev-parse', 'HEAD'], { cwd: trunk })).stdout.trim()
  const exists = await databaseExists(conn, name)
  if (exists && state.copiedAt && !opts.recopy) {
    if (state.migratedSha === sha) return name
    await dropSpare(conn, name)
    log(`${repo.name}: aplicando migraciones nuevas de ${repo.trunk} a la base madre…`)
    try {
      for (const line of repo.setup) await runShell(line, { cwd: trunk, env: dbEnv(cfg, repo, name) })
    } catch (e) {
      throw new Error(
        `Las migraciones nuevas de ${repo.trunk} fallaron en la base madre. Usa "Reconstruir base madre" en Repos.\n${(e as Error).message}`
      )
    }
    writeState(cfg, repo.name, { ...state, migratedSha: sha })
    return name
  }

  await dropSpare(conn, name)
  if (exists) await dropDatabase(conn, name)
  writeState(cfg, repo.name, {})
  log(`${repo.name}: armando la base madre vacía con las migraciones de ${repo.trunk} (sólo cuando cambian)…`)
  await createDatabase(conn, name)
  try {
    for (const line of repo.setup) await runShell(line, { cwd: trunk, env: dbEnv(cfg, repo, name) })
  } catch (e) {
    throw new Error(`Las migraciones de ${repo.trunk} no corren en una base vacía.
${(e as Error).message}`)
  }
  log(`${repo.name}: sembrando usuario y datos de ejemplo…`)
  try {
    for (const line of repo.db!.seed ?? []) await runShell(line, { cwd: trunk, env: dbEnv(cfg, repo, name) })
  } catch (e) {
    throw new Error(`La semilla de ${repo.name} falló.
${(e as Error).message}`)
  }
  writeState(cfg, repo.name, { copiedAt: new Date().toISOString(), migratedSha: sha })
  return name
}

async function dropSpare(conn: Parameters<typeof dropDatabase>[0], golden: string): Promise<void> {
  if (await databaseExists(conn, spareName(golden))) await dropDatabase(conn, spareName(golden))
}

export function spareName(golden: string): string {
  return `${golden}_spare`
}

/** A clone of the golden kept ready so a new session only has to rename it (instant). */
export async function prepareSpare(cfg: AppConfig, repo: RepoConfig): Promise<void> {
  const { conn } = dbSource(repo)
  const golden = goldenName(repo.name)
  await inflight.get(`${cfg.root}|${repo.name}`)?.catch(() => {})
  if (!(await databaseExists(conn, golden))) return
  if (!(await databaseExists(conn, spareName(golden)))) await cloneDatabase(conn, golden, spareName(golden))
}

let refill: Promise<void> = Promise.resolve()

/** Lets tests (and shutdown) wait for the background spare refill. */
export function waitSpareRefill(): Promise<void> {
  return refill
}

/** Session db from the golden: takes the spare if there is one, otherwise clones; then refills the spare. */
export async function cloneFromGolden(cfg: AppConfig, repo: RepoConfig, target: string): Promise<void> {
  const { conn } = dbSource(repo)
  const golden = goldenName(repo.name)
  const spare = spareName(golden)
  if (await databaseExists(conn, spare)) await renameDatabase(conn, spare, target)
  else await cloneDatabase(conn, golden, target)
  refill = refill.then(() => prepareSpare(cfg, repo)).catch(() => {})
}

/** Trunk commit the golden db is migrated to, if known. */
export function goldenSha(cfg: AppConfig, repo: string): string | undefined {
  return readState(cfg, repo).migratedSha
}
