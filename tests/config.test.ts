import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { ConfigError, detectRepos, loadConfig } from '../src/main/core/config'
import { makeOriginAndClone, tempDir } from './helpers/git'

function writeConfig(root: string, cfg: unknown): void {
  writeFileSync(join(root, 'agentify.config.json'), JSON.stringify(cfg))
}

const agent = { id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }

describe('loadConfig', () => {
  test('resolves relative repo paths against root', () => {
    const root = tempDir()
    writeConfig(root, {
      branchPrefix: 'me',
      repos: [{ name: 'svc', path: 'svc', trunk: 'main' }],
      agents: [agent],
      defaultAgent: 'claude'
    })
    const cfg = loadConfig(root)
    expect(cfg.root).toBe(root)
    expect(cfg.repos[0].path).toBe(join(root, 'svc'))
    expect(cfg.repos[0].copyFiles).toEqual([])
    expect(cfg.repos[0].setup).toEqual([])
  })

  test('keeps test users through load and save', async () => {
    const root = tempDir()
    writeConfig(root, {
      branchPrefix: 'me',
      repos: [{ name: 'svc', path: 'svc', trunk: 'main' }],
      agents: [agent],
      defaultAgent: 'claude',
      testUsers: [{ label: 'Admin', email: 'admin@local.test', password: 'pw' }]
    })
    const cfg = loadConfig(root)
    expect(cfg.testUsers).toEqual([{ label: 'Admin', email: 'admin@local.test', password: 'pw' }])
    const { saveConfig } = await import('../src/main/core/config')
    saveConfig(cfg)
    expect(loadConfig(root).testUsers).toHaveLength(1)
  })

  test('reports every problem at once', () => {
    const root = tempDir()
    writeConfig(root, {
      branchPrefix: 'me',
      repos: [{ name: 'svc', path: 'svc' }],
      agents: [agent],
      defaultAgent: 'x'
    })
    try {
      loadConfig(root)
      throw new Error('expected ConfigError')
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError)
      expect((e as ConfigError).problems).toHaveLength(2)
    }
  })
})

describe('detectRepos', () => {
  test('finds git repos and their trunk, ignores plain folders', async () => {
    const root = tempDir()
    makeOriginAndClone(root, 'master', 'svc')
    mkdirSync(join(root, 'notes'))
    const repos = await detectRepos(root)
    const svc = repos.find((r) => r.name === 'svc')
    expect(svc?.trunk).toBe('master')
    expect(svc?.path).toBe(join(root, 'svc'))
    expect(repos.find((r) => r.name === 'notes')).toBeUndefined()
  })
})

describe('ticket provider', () => {
  const base = { branchPrefix: 'me', repos: [{ name: 'svc', path: 'svc', trunk: 'main' }], agents: [agent], defaultAgent: 'claude' }

  test('keeps the chosen provider and extra GitHub repos through load and save', async () => {
    const root = tempDir()
    writeConfig(root, { ...base, tickets: { provider: 'github', githubRepos: ['org/issues'] } })
    const { saveConfig } = await import('../src/main/core/config')
    saveConfig(loadConfig(root))
    expect(loadConfig(root).tickets).toEqual({ provider: 'github', githubRepos: ['org/issues'] })
  })

  test('drops an unknown provider', () => {
    const root = tempDir()
    writeConfig(root, { ...base, tickets: { provider: 'jira' } })
    expect(loadConfig(root).tickets).toBeUndefined()
  })

  test('without a choice: Linear when its key exists, otherwise manual', async () => {
    const { ticketProvider } = await import('../src/main/core/config')
    const root = tempDir()
    writeConfig(root, base)
    const cfg = loadConfig(root)
    expect(ticketProvider(cfg, true)).toBe('linear')
    expect(ticketProvider(cfg, false)).toBe('manual')
    expect(ticketProvider({ ...cfg, tickets: { provider: 'github' } }, true)).toBe('github')
  })
})

describe('bots', () => {
  const base = { branchPrefix: 'me', repos: [{ name: 'svc', path: 'svc', trunk: 'main' }], agents: [agent], defaultAgent: 'claude' }
  const bot = { id: 'my-bot', name: 'My Bot', avatar: '🤖', routineId: 'trig_1', label: 'my-bot', commentPrefix: 'My Bot ·', readyCheck: 'review · ready', autoIterate: true }

  test('bots survive load and save', async () => {
    const root = tempDir()
    writeConfig(root, { ...base, bots: [bot] })
    const { saveConfig } = await import('../src/main/core/config')
    saveConfig(loadConfig(root))
    expect(loadConfig(root).bots).toEqual([bot])
  })

  test('a bot without routine, label or prefix is a config problem', () => {
    const root = tempDir()
    writeConfig(root, { ...base, bots: [{ id: 'x', name: 'X' }] })
    expect(() => loadConfig(root)).toThrow(/routineId/)
  })
})
