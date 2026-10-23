import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type SessionRepo = {
  name: string
  worktree: string
  branch: string
  createdBranch: boolean
  db?: string
}

export type Session = {
  id: string
  ticket: string
  title: string
  repos: SessionRepo[]
  agent: string
  createdAt: string
  imported: boolean
  /** Session dbs for repos not in the session (created when Probar runs them from trunk). */
  extraDbs?: { repo: string; db: string }[]
}

export function stateDir(root: string): string {
  return join(root, '.agentify')
}

function storeFile(root: string): string {
  return join(stateDir(root), 'sessions.json')
}

export function readSessions(root: string): Session[] {
  const f = storeFile(root)
  if (!existsSync(f)) return []
  return JSON.parse(readFileSync(f, 'utf8'))
}

export function writeSessions(root: string, sessions: Session[]): void {
  mkdirSync(stateDir(root), { recursive: true })
  const f = storeFile(root)
  const tmp = `${f}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify(sessions, null, 2) + '\n')
  renameSync(tmp, f)
}

export function updateSession(root: string, id: string, patch: Partial<Session>): Session[] {
  const all = readSessions(root).map((s) => (s.id === id ? { ...s, ...patch } : s))
  writeSessions(root, all)
  return all
}
