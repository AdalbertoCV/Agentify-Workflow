import { existsSync } from 'node:fs'
import type { AppConfig } from './config'
import { run } from './proc'
import type { Session } from './store'

export type CommitResult = {
  repo: string
  committed: boolean
  pushed: boolean
  sha?: string
  /** The branch was rewritten (rebase) and went up with --force-with-lease. */
  forced?: boolean
  error?: string
}

const PROTECTED = new Set(['main', 'master', 'develop', 'production', 'prod'])

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await run('git', args, { cwd })).stdout.trim()
}

/** Commit everything the session changed (never the files the tool placed) and push each branch. */
export async function commitAndPush(cfg: AppConfig, s: Session, message: string): Promise<CommitResult[]> {
  const out: CommitResult[] = []
  for (const r of s.repos) {
    const res: CommitResult = { repo: r.name, committed: false, pushed: false }
    out.push(res)
    if (!existsSync(r.worktree)) continue
    try {
      const repo = cfg.repos.find((x) => x.name === r.name)
      const branch = await git(r.worktree, 'branch', '--show-current')
      if (!branch) throw new Error('El worktree no está en una rama')
      if (PROTECTED.has(branch) || branch === repo?.trunk)
        throw new Error(`Me niego a hacer push a ${branch}: es una rama protegida`)

      const placed = repo ? [...repo.copyFiles, ...repo.linkDirs] : []
      await git(r.worktree, 'add', '-A', '--', '.', ...placed.map((p) => `:(exclude)${p}`))
      const staged = await git(r.worktree, 'diff', '--cached', '--name-only')
      if (staged) {
        if (!message.trim()) throw new Error('Escribe un mensaje de commit')
        await git(r.worktree, 'commit', '-m', message.trim())
        res.committed = true
      }
      const ahead = await git(r.worktree, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
      if (Number(ahead) > 0) {
        const remote = await git(r.worktree, 'rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`).catch(
          () => ''
        )
        const rewritten =
          remote &&
          !(await git(r.worktree, 'merge-base', '--is-ancestor', remote, 'HEAD').then(
            () => true,
            () => false
          ))
        // A lease only overwrites the commit we last saw on origin, never someone else's push.
        const lease = rewritten ? [`--force-with-lease=${branch}:${remote}`] : []
        await git(r.worktree, 'push', '-u', ...lease, 'origin', branch)
        res.pushed = true
        if (rewritten) res.forced = true
      }
      res.sha = await git(r.worktree, 'rev-parse', '--short', 'HEAD')
    } catch (e) {
      res.error = (e as Error).message
    }
  }
  return out
}
