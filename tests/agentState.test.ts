import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { agentState, installClaudeHooks } from '../src/main/core/agentState'
import { tempDir } from './helpers/git'

test('installClaudeHooks writes the three hook events', () => {
  const dir = tempDir()
  installClaudeHooks(dir)
  const json = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
  expect(Object.keys(json.hooks).sort()).toEqual(['Notification', 'Stop', 'UserPromptSubmit'])
  expect(json.hooks.Stop[0].hooks[0].command).toContain('waiting')
  expect(json.hooks.UserPromptSubmit[0].hooks[0].command).toContain('working')
})

test('installClaudeHooks keeps existing settings', () => {
  const dir = tempDir()
  mkdirSync(join(dir, '.claude'))
  writeFileSync(join(dir, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['x'] } }))
  installClaudeHooks(dir)
  const json = JSON.parse(readFileSync(join(dir, '.claude', 'settings.local.json'), 'utf8'))
  expect(json.permissions.allow).toEqual(['x'])
})

test('idle mode waits after 4s without output; hooks mode reads the state file', () => {
  const dir = tempDir()
  expect(agentState(dir, 'idle', 1000, 6000)).toBe('waiting')
  expect(agentState(dir, 'idle', 5000, 6000)).toBe('working')
  mkdirSync(join(dir, '.agentify'))
  writeFileSync(join(dir, '.agentify', 'agent-state'), 'waiting')
  expect(agentState(dir, 'claude-hooks', 5000, 6000)).toBe('waiting')
})
