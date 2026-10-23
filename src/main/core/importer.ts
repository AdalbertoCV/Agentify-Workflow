import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { AppConfig } from './config'
import { listWorktrees } from './git'
import { readSessions, writeSessions, type Session } from './store'

const TICKET = /(?:^|[/_-])([a-z][a-z0-9]{1,9})-(\d+)(?=$|[-_/])/i

export function samePath(a: string, b: string): boolean {
  const n = (p: string): string => {
    const r = resolve(p).replace(/[\\/]+$/, '')
    return process.platform === 'win32' ? r.toLowerCase() : r
  }
  return n(a) === n(b)
}

/** Worktrees created by hand or by other tools, grouped into sessions by ticket number. */
export async function scanLooseWorktrees(cfg: AppConfig): Promise<Session[]> {
  const known = readSessions(cfg.root).flatMap((s) => s.repos.map((r) => r.worktree))
  const groups = new Map<string, Session>()
  for (const repo of cfg.repos) {
    if (!existsSync(repo.path)) continue
    let entries
    try {
      entries = await listWorktrees(repo.path)
    } catch {
      continue
    }
    for (const wt of entries) {
      if (wt.main || !existsSync(wt.path)) continue
      if (known.some((k) => samePath(k, wt.path))) continue
      if (resolve(wt.path).includes(resolve(cfg.root, '.agentify'))) continue
      const folder = basename(wt.path)
      // A ticket key like ENG-123 in the branch or folder groups the worktrees of one ticket.
      const key = TICKET.exec(wt.branch ?? '') ?? TICKET.exec(folder)
      const num = key ? null : /(?:^|[^\d])(\d{3,6})(?:[^\d]|$)/.exec(folder)
      const id = key ? `${key[1]}-${key[2]}`.toLowerCase() : num ? `ticket-${num[1]}` : folder.toLowerCase()
      const branch = wt.branch ?? '(detached)'
      let s = groups.get(id)
      if (!s) {
        s = {
          id,
          ticket: id.toUpperCase(),
          title: branch.replace(/^[^/]+\//, ''),
          repos: [],
          agent: cfg.defaultAgent,
          createdAt: new Date().toISOString(),
          imported: true
        }
        groups.set(id, s)
      }
      s.repos.push({
        name: repo.name,
        worktree: wt.path,
        branch,
        createdBranch: Boolean(wt.branch)
      })
    }
  }
  return [...groups.values()]
}

export async function adoptLooseWorktrees(cfg: AppConfig): Promise<number> {
  const loose = await scanLooseWorktrees(cfg)
  if (!loose.length) return 0
  const current = readSessions(cfg.root)
  const merged = [...current]
  for (const s of loose) {
    const existing = merged.find((x) => x.id === s.id)
    if (existing) existing.repos.push(...s.repos)
    else merged.push(s)
  }
  writeSessions(cfg.root, merged)
  return loose.length
}
