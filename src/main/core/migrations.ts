import { createHash } from 'node:crypto'
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RepoConfig } from './config'
import { run } from './proc'

/**
 * Identifies the migration files of a worktree as they are on disk, committed or not, so a
 * session db is only migrated again when they change. Null when the repo declares no paths.
 */
export async function migrationsFingerprint(repo: RepoConfig, wt: string): Promise<string | null> {
  const paths = repo.db?.migrationPaths
  if (!paths?.length) return null
  const { stdout } = await run('git', ['ls-files', '-c', '-o', '--exclude-standard', '--', ...paths], { cwd: wt })
  const hash = createHash('sha1')
  for (const f of stdout.split(/\r?\n/).filter(Boolean).sort()) {
    const p = join(wt, f)
    if (!existsSync(p)) continue
    const st = statSync(p)
    hash.update(`${f}:${st.size}:${st.mtimeMs}\n`)
  }
  return hash.digest('hex')
}

/** Fingerprint the session db of `repo` was last migrated at; kept in the session folder. */
export function migratedFingerprint(sessionDir: string, repo: string): string | null {
  const f = join(sessionDir, `.migrated-${repo}`)
  return existsSync(f) ? readFileSync(f, 'utf8').trim() : null
}

export function markMigrated(sessionDir: string, repo: string, fingerprint: string): void {
  writeFileSync(join(sessionDir, `.migrated-${repo}`), fingerprint)
}
