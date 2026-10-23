import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

export function tempDir(prefix = 'agentify-'): string {
  return mkdtempSync(join(tmpdir(), prefix))
}

/** Bare origin with one commit on `trunk`, cloned into `<dir>/<name>`. */
export function makeOriginAndClone(
  dir: string,
  trunk = 'main',
  name = 'svc'
): { origin: string; clone: string } {
  const origin = join(dir, `${name}-origin.git`)
  const seed = join(dir, `${name}-seed`)
  const clone = join(dir, name)
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', trunk)
  git(seed, 'config', 'user.email', 't@t')
  git(seed, 'config', 'user.name', 't')
  writeFileSync(join(seed, 'README.md'), 'hi\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'init')
  git(dir, 'init', '-q', '--bare', '-b', trunk, origin)
  git(seed, 'push', '-q', origin, trunk)
  git(dir, 'clone', '-q', origin, clone)
  git(clone, 'config', 'user.email', 't@t')
  git(clone, 'config', 'user.name', 't')
  return { origin, clone }
}

/** Push a new commit on `branch` to origin from a throwaway clone. Returns its sha. */
export function pushBranch(dir: string, origin: string, branch: string, from = 'main'): string {
  const tmp = join(dir, `push-${branch.replace(/\W/g, '_')}`)
  git(dir, 'clone', '-q', origin, tmp)
  git(tmp, 'config', 'user.email', 't@t')
  git(tmp, 'config', 'user.name', 't')
  git(tmp, 'checkout', '-q', '-B', branch, `origin/${from}`)
  writeFileSync(join(tmp, 'extra.txt'), 'x\n')
  git(tmp, 'add', '.')
  git(tmp, 'commit', '-qm', 'extra')
  git(tmp, 'push', '-q', 'origin', branch)
  return git(tmp, 'rev-parse', 'HEAD')
}
