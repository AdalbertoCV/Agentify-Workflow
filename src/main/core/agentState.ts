import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AgentState = 'working' | 'waiting'

const IDLE_MS = 4000

function hook(state: AgentState): { hooks: { type: 'command'; command: string }[] }[] {
  const dir = '"$CLAUDE_PROJECT_DIR/.agentify"'
  return [
    {
      hooks: [
        { type: 'command', command: `mkdir -p ${dir} && printf ${state} > ${dir.slice(0, -1)}/agent-state"` }
      ]
    }
  ]
}

/** Claude Code hooks that record in the session folder whether the agent is waiting for you. */
export function installClaudeHooks(sessionDir: string): void {
  const file = join(sessionDir, '.claude', 'settings.local.json')
  mkdirSync(join(sessionDir, '.claude'), { recursive: true })
  const current = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
  current.hooks = {
    ...(current.hooks ?? {}),
    Notification: hook('waiting'),
    Stop: hook('waiting'),
    UserPromptSubmit: hook('working')
  }
  writeFileSync(file, JSON.stringify(current, null, 2) + '\n')
}

export function agentState(
  sessionDir: string,
  mode: 'claude-hooks' | 'idle',
  lastOutputAt: number,
  now: number
): AgentState {
  if (mode === 'claude-hooks') {
    const f = join(sessionDir, '.agentify', 'agent-state')
    if (existsSync(f)) return readFileSync(f, 'utf8').trim() === 'waiting' ? 'waiting' : 'working'
    return 'working'
  }
  return now - lastOutputAt > IDLE_MS ? 'waiting' : 'working'
}
