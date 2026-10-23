import { execFileSync } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { copyDatabase, databaseExists, dropDatabase, type PgConn } from '../src/main/core/db'

const enabled = process.env.AGENTIFY_PG_TEST === '1'
const conn: PgConn = {
  user: process.env.PGUSER ?? 'postgres',
  password: process.env.PGPASSWORD ?? '',
  host: process.env.PGHOST ?? 'localhost',
  port: process.env.PGPORT ?? '5432'
}

function psql(db: string, sql: string): string {
  return execFileSync(
    'psql',
    ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', db, '-tAc', sql],
    { env: { ...process.env, PGPASSWORD: conn.password }, encoding: 'utf8' }
  ).trim()
}

describe.skipIf(!enabled)('copyDatabase (real postgres)', () => {
  test('copies data into a new db and drops it', async () => {
    await dropDatabase(conn, 'agentify_src_test')
    await dropDatabase(conn, 'agentify_dst_test')
    psql('postgres', 'create database agentify_src_test')
    psql('agentify_src_test', "create table t(x text); insert into t values ('hola')")
    await copyDatabase(conn, 'agentify_src_test', 'agentify_dst_test')
    expect(psql('agentify_dst_test', 'select x from t')).toBe('hola')
    await dropDatabase(conn, 'agentify_dst_test')
    expect(await databaseExists(conn, 'agentify_dst_test')).toBe(false)
    await dropDatabase(conn, 'agentify_src_test')
  })
})
