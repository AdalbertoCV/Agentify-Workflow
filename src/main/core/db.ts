import { spawn } from 'node:child_process'
import { childEnv, ProcError, run } from './proc'

export type PgConn = { user: string; password: string; host: string; port: string }

function pgArgs(conn: PgConn): string[] {
  return ['-h', conn.host || 'localhost', '-p', conn.port || '5432', '-U', conn.user]
}

function pgEnv(conn: PgConn): Record<string, string> {
  return { PGPASSWORD: conn.password }
}

export async function databaseExists(conn: PgConn, name: string): Promise<boolean> {
  const { stdout } = await run(
    'psql',
    [
      ...pgArgs(conn),
      '-d',
      'postgres',
      '-tAc',
      `select 1 from pg_database where datname='${name.replace(/'/g, "''")}'`
    ],
    { cwd: process.cwd(), env: pgEnv(conn) }
  )
  return stdout.trim() === '1'
}

/** pg_dump of `source` piped into pg_restore of a freshly created `target`. */
export async function copyDatabase(conn: PgConn, source: string, target: string): Promise<void> {
  await run('createdb', [...pgArgs(conn), target], { cwd: process.cwd(), env: pgEnv(conn) })
  try {
    await new Promise<void>((resolve, reject) => {
      const env = { ...childEnv(), ...pgEnv(conn) }
      const dump = spawn('pg_dump', [...pgArgs(conn), '-Fc', source], { env, windowsHide: true })
      const restore = spawn(
        'pg_restore',
        [...pgArgs(conn), '--no-owner', '--no-acl', '-d', target],
        {
          env,
          windowsHide: true
        }
      )
      let dumpErr = ''
      let restoreErr = ''
      dump.stderr.on('data', (d) => (dumpErr += d))
      restore.stderr.on('data', (d) => (restoreErr += d))
      dump.stdout.pipe(restore.stdin)
      let dumpCode: number | null = null
      dump.on('close', (c) => (dumpCode = c))
      dump.on('error', (e) => reject(new ProcError('pg_dump', null, e.message)))
      restore.on('error', (e) => reject(new ProcError('pg_restore', null, e.message)))
      restore.on('close', (code) => {
        if (dumpCode !== 0 && dumpCode !== null) reject(new ProcError('pg_dump', dumpCode, dumpErr))
        else if (code !== 0) reject(new ProcError('pg_restore', code, restoreErr))
        else resolve()
      })
    })
  } catch (e) {
    await dropDatabase(conn, target).catch(() => {})
    throw e
  }
}

export async function createDatabase(conn: PgConn, name: string): Promise<void> {
  await run('createdb', [...pgArgs(conn), name], { cwd: process.cwd(), env: pgEnv(conn) })
}

/**
 * File-level copy of `template` (seconds). Needs no open connections to the template.
 * `file_copy` (Postgres 15+) skips writing the whole db through the WAL, several times faster.
 */
export async function cloneDatabase(conn: PgConn, template: string, target: string): Promise<void> {
  const opts = { cwd: process.cwd(), env: pgEnv(conn) }
  try {
    await run('createdb', [...pgArgs(conn), '--strategy=file_copy', '-T', template, target], opts)
  } catch (e) {
    if (!/strategy/i.test((e as Error).message)) throw e
    await run('createdb', [...pgArgs(conn), '-T', template, target], opts)
  }
}

export async function renameDatabase(conn: PgConn, from: string, to: string): Promise<void> {
  const q = (n: string): string => `"${n.replace(/"/g, '""')}"`
  await run(
    'psql',
    [...pgArgs(conn), '-d', 'postgres', '-c', `ALTER DATABASE ${q(from)} RENAME TO ${q(to)}`],
    {
      cwd: process.cwd(),
      env: pgEnv(conn)
    }
  )
}

export async function dropDatabase(conn: PgConn, name: string): Promise<void> {
  await run('dropdb', [...pgArgs(conn), '--if-exists', '--force', name], {
    cwd: process.cwd(),
    env: pgEnv(conn)
  })
}
