import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { run } from './proc'

export type BuildInfo = { version: string; commit?: string }

async function headOf(dir: string): Promise<string | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined
  try {
    return (await run('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir })).stdout.trim() || undefined
  } catch {
    return undefined
  }
}

/** Version and, when running from a git checkout, the commit the app started from. */
export async function buildInfo(appDir: string): Promise<BuildInfo> {
  const { version } = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')) as { version: string }
  const commit = await headOf(appDir)
  return commit ? { version, commit } : { version }
}

/**
 * The commit now checked out on disk when it differs from the one the app started from: the
 * running main process still has the old code until the app restarts.
 */
export async function newerOnDisk(appDir: string, started: BuildInfo): Promise<string | null> {
  if (!started.commit) return null
  const now = await headOf(appDir)
  return now && now !== started.commit ? now : null
}
