import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { ticketPrompt } from '../src/main/core/tickets'

const cfg = {
  root: 'C:/r',
  branchPrefix: 'p',
  repos: [],
  agents: [],
  defaultAgent: 'claude'
} as unknown as AppConfig

test('a custom prompt from the config wins and gets the context', () => {
  const custom = { ...cfg, tickets: { provider: 'linear' as const }, ticketPrompt: '/team:ticket {context}' }
  expect(ticketPrompt(custom, 'linear', { context: 'el detalle de la RFQ truena' })).toBe(
    '/team:ticket el detalle de la RFQ truena'
  )
})

test('Linear by default asks the agent to use its Linear tools', () => {
  const p = ticketPrompt(cfg, 'linear', { context: 'algo falla' })
  expect(p).toContain('Linear')
  expect(p).toContain('algo falla')
})

test('GitHub Issues by default creates the issue with gh in the chosen repo', () => {
  const p = ticketPrompt(cfg, 'github', { context: 'algo falla', githubRepo: 'org/api' })
  expect(p).toContain('gh issue create -R org/api')
  expect(p).toContain('algo falla')
})

test('GitHub Issues needs a repo, and manual cannot create tickets', () => {
  expect(() => ticketPrompt(cfg, 'github', { context: 'x' })).toThrow()
  expect(() => ticketPrompt(cfg, 'manual', { context: 'x' })).toThrow()
})

test('the context goes in as one line, so a terminal never submits it early', () => {
  const p = ticketPrompt(cfg, 'linear', { context: 'línea 1\nlínea 2' })
  expect(p).not.toMatch(/\n/)
})
