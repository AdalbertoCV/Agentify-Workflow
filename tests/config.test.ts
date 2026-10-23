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
