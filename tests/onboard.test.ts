import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { ConfigError, configPath, type AppConfig } from '../src/main/core/config'
import { onboardPrompt, readOnboardResult, saveRepo } from '../src/main/core/onboard'
import { tempDir } from './helpers/git'

function cfg(root: string): AppConfig {
  return {
    root,
    branchPrefix: 'p',
    repos: [
      { name: 'api', path: join(root, 'api'), trunk: 'main', copyFiles: [], linkDirs: [], setup: [] }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
}

test('prompt names the repo, the port contract and the other repos', () => {
  const root = tempDir()
  const p = onboardPrompt('web', join(root, 'web'), join(root, '.agentify', 'repos', 'web'), cfg(root))
  expect(p).toContain('web')
  expect(p).toContain('AGENTIFY_PORT')
  expect(p).toContain('api')
  expect(p).toContain('repo.json')
})

test('result without trunk is rejected', () => {
  const root = tempDir()
  const work = join(root, 'w')
  mkdirSync(work)
  writeFileSync(join(work, 'repo.json'), JSON.stringify({ name: 'web', run: { script: 'x' } }))
  writeFileSync(join(work, 'run.sh'), 'echo')
  expect(() => readOnboardResult(work, root)).toThrow(ConfigError)
})

test('saveRepo replaces an existing repo and persists the config', () => {
  const root = tempDir()
  const c = cfg(root)
  const next = saveRepo(c, {
    name: 'api',
    path: join(root, 'api'),
    trunk: 'master',
    copyFiles: ['.env'],
    linkDirs: [],
    setup: []
  })
  expect(next.repos).toHaveLength(1)
  expect(next.repos[0].trunk).toBe('master')
  const saved = JSON.parse(readFileSync(configPath(root), 'utf8'))
  expect(saved.repos[0]).toMatchObject({ name: 'api', path: 'api', trunk: 'master' })
})
