import { spawn as ptySpawn, type IPty } from '@lydell/node-pty'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentConfig } from './core/config'
import { resolveCommand } from './core/proc'

const HISTORY_LIMIT = 400_000
export const STARTED_MARKER = '.agentify-started'
const RESUME_GRACE_MS = 8000

/**
 * Markers a running Claude Code session puts in its children's environment. If the app was
 * launched from one, agents would inherit them and act as sub-sessions (no saved transcripts,
 * so `--continue` finds nothing). Configuration variables are left alone.
 */
const PARENT_SESSION_VARS = [
  'CLAUDECODE',
  'CLAUDE_PID',
  'CLAUDE_EFFORT',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN'
]

function agentEnv(extra: Record<string, string>): Record<string, string> {
  const env = { ...process.env, ...extra, FORCE_COLOR: '1' } as Record<string, string>
  for (const k of PARENT_SESSION_VARS) delete env[k]
  return env
}

type Entry = { pty: IPty; history: string; lastOutputAt: number }

export class PtyManager {
  private entries = new Map<string, Entry>()
  private histories = new Map<string, string>()
  private dataCbs: ((id: string, data: string) => void)[] = []
  private exitCbs: ((id: string, code: number) => void)[] = []

  isOpen(id: string): boolean {
    return this.entries.has(id)
  }

  async open(
    id: string,
    cwd: string,
    agent: AgentConfig,
    env: Record<string, string> = {},
    firstArgs?: string[],
    /** Sent as the first message only on the very first open of this folder. */
    startPrompt?: string
  ): Promise<void> {
    if (this.entries.has(id)) return
    // Explicit first args (a one-off terminal) bypass the resume marker entirely.
    const marker = join(cwd, STARTED_MARKER)
    const started = !firstArgs && existsSync(marker)
    const args =
      firstArgs ?? (started ? agent.resumeArgs : startPrompt ? [...agent.args, startPrompt] : agent.args)
    const cmd = await resolveCommand(agent.command, args)
    const pty = ptySpawn(cmd.file, cmd.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 32,
      cwd,
      env: agentEnv(env)
    })
    if (!firstArgs && !started) writeFileSync(marker, new Date().toISOString())
    const entry: Entry = { pty, history: this.histories.get(id) ?? '', lastOutputAt: Date.now() }
    this.entries.set(id, entry)
    pty.onData((d) => {
      entry.history = (entry.history + d).slice(-HISTORY_LIMIT)
      entry.lastOutputAt = Date.now()
      this.histories.set(id, entry.history)
      for (const cb of this.dataCbs) cb(id, d)
    })
    const startedAt = Date.now()
    pty.onExit(({ exitCode }) => {
      this.histories.set(id, entry.history)
      this.entries.delete(id)
      // "Resume" with nothing to resume (e.g. `claude --continue` before any message) ends at once:
      // start a new conversation instead of leaving a dead terminal.
      if (started && Date.now() - startedAt < RESUME_GRACE_MS && exitCode !== 0) {
        const note = '\r\n\x1b[90m[no había conversación que retomar; abro una nueva]\x1b[0m\r\n'
        entry.history += note
        for (const cb of this.dataCbs) cb(id, note)
        void this.open(id, cwd, agent, env, agent.args).catch((e) => {
          const msg = `\r\n\x1b[31m${(e as Error).message}\x1b[0m\r\n`
          for (const cb of this.dataCbs) cb(id, msg)
        })
        return
      }
      for (const cb of this.exitCbs) cb(id, exitCode)
    })
  }

  history(id: string): string {
    return this.entries.get(id)?.history ?? this.histories.get(id) ?? ''
  }

  lastOutputAt(id: string): number {
    return this.entries.get(id)?.lastOutputAt ?? 0
  }

  write(id: string, data: string): void {
    this.entries.get(id)?.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.entries.get(id)?.pty.resize(cols, rows)
  }

  kill(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    this.entries.delete(id)
    try {
      e.pty.kill()
    } catch {
      // already gone
    }
  }

  forget(id: string): void {
    this.kill(id)
    this.histories.delete(id)
  }

  killAll(): void {
    for (const id of [...this.entries.keys()]) this.kill(id)
  }

  onData(cb: (id: string, data: string) => void): void {
    this.dataCbs.push(cb)
  }

  onExit(cb: (id: string, code: number) => void): void {
    this.exitCbs.push(cb)
  }
}
