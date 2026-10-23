import { existsSync, lstatSync, readdirSync, rmdirSync, symlinkSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** Directory link: a junction on Windows (no admin needed), a symlink elsewhere. */
export function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, process.platform === 'win32' ? 'junction' : 'dir')
}

export function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

/** Removes only the link itself, never what it points to. */
export function removeLink(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Some Windows junctions refuse unlink; rmdir without recursion drops only the link.
    rmdirSync(path)
  }
}

/**
 * Removes every first-level entry of `dir` that is a symlink or junction.
 * Never recursive: a deletion that follows a junction would empty its target.
 */
export function unlinkTopLevelLinks(dir: string): string[] {
  if (!existsSync(dir)) return []
  const removed: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (isLink(p)) {
      removeLink(p)
      removed.push(name)
    }
  }
  return removed
}
