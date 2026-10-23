import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'
import { run } from './proc'
import type { Session } from './store'

export type RepoDiff = { repo: string; patch: string; files: number; unpushed: number }

const MAX_NEW_FILE = 200_000

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout
}

function newFilePatch(wt: string, file: string): string {
  const p = join(wt, file)
  let body = ''
  try {
    if (statSync(p).size > MAX_NEW_FILE) body = '+(archivo grande, omitido)\n'
    else {
      const text = readFileSync(p, 'utf8')
      if (text.includes('\u0000')) body = '+(binario)\n'
      else {
        const lines = text.replace(/\n$/, '').split('\n')
        body = `@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`
      }
    }
  } catch {
    body = ''
  }
  return `diff --git a/${file} b/${file}\nnew file mode 100644\n--- /dev/null\n+++ b/${file}\n${body}`
}

/** Per repo: uncommitted edits and new files, plus how many commits are not on origin yet. */
export async function sessionDiff(cfg: AppConfig, s: Session): Promise<RepoDiff[]> {
  const out: RepoDiff[] = []
  for (const r of s.repos) {
    if (!existsSync(r.worktree)) continue
    const repo = cfg.repos.find((x) => x.name === r.name)
    const placed = new Set(repo ? [...repo.copyFiles, ...repo.linkDirs] : [])
    // Only what is not committed yet; committed work shows up as "commits sin subir".
    const tracked = await git(r.worktree, 'diff', '--no-color', 'HEAD')
    const names = (await git(r.worktree, 'diff', '--name-only', 'HEAD')).split(/\r?\n/).filter(Boolean)
    let unpushed = 0
    try {
      unpushed = Number((await git(r.worktree, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin')).trim())
    } catch {
      // no remote: nothing to compare against
    }
    const untracked = (await git(r.worktree, 'ls-files', '--others', '--exclude-standard'))
      .split(/\r?\n/)
      .filter((f) => f && !placed.has(f) && ![...placed].some((p) => f.startsWith(`${p}/`)))
    out.push({
      repo: r.name,
      patch: tracked + untracked.map((f) => newFilePatch(r.worktree, f)).join(''),
      files: names.length + untracked.length,
      unpushed
    })
  }
  return out
}
