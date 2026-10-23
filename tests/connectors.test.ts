import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { checkConnectors } from '../src/main/core/connectors'
import { ProcError } from '../src/main/core/proc'

const cfg = {
  root: 'C:/r',
  repos: [],
  agents: [{ id: 'claude', label: 'Claude Code', command: 'claude', args: [], resumeArgs: [] }],
  defaultAgent: 'claude',
  branchPrefix: 'p',
  extraChecks: [{ label: 'Skills', command: 'claude plugin list', expect: 'team-skills', fix: 'install it' }],
  tickets: { provider: 'linear' }
} as AppConfig

test('reports failing tools with a fix and working ones with detail', async () => {
  const run = async (cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> => {
    const line = [cmd, ...args].join(' ')
    if (line.startsWith('docker')) throw new ProcError(line, 1, 'daemon not running')
    if (line === 'claude --version') return { stdout: '2.5.0 (Claude Code)\n', stderr: '' }
    if (line.startsWith('gh auth status'))
      return { stdout: '', stderr: '✓ Logged in to github.com account me\n  - Active account: true\n' }
    return { stdout: 'ok\n', stderr: '' }
  }
  const checks = await checkConnectors(cfg, {
    run,
    shell: async () => ({ stdout: 'nothing here', stderr: '' }),
    secret: () => null,
    fetchFn: fetch
  })
  const byId = Object.fromEntries(checks.map((c) => [c.id, c]))
  expect(byId.docker.ok).toBe(false)
  expect(byId.docker.fix).toBeDefined()
  expect(byId['agent:claude']).toMatchObject({ ok: true, detail: '2.5.0 (Claude Code)' })
  expect(byId.gh.detail).toContain('me')
  expect(byId.linear.ok).toBe(false)
  expect(byId.linear.fix?.kind).toBe('secret')
  expect(byId['extra:0']).toMatchObject({ ok: false, fix: { kind: 'command', value: 'install it' } })
})

const quiet = {
  run: async (): Promise<{ stdout: string; stderr: string }> => ({ stdout: 'ok', stderr: '' }),
  shell: async () => ({ stdout: '', stderr: '' }),
  secret: () => 'lin_key',
  fetchFn: fetch
}

test('with GitHub Issues as provider: a GitHub Issues check and no Linear one', async () => {
  const checks = await checkConnectors(
    { ...cfg, extraChecks: [], tickets: { provider: 'github', githubRepos: ['org/issues'] } },
    quiet
  )
  const ids = checks.map((c) => c.id)
  expect(ids).not.toContain('linear')
  expect(checks.find((c) => c.id === 'github-issues')).toMatchObject({ ok: true, label: 'GitHub Issues' })
  expect(checks.find((c) => c.id === 'github-issues')?.detail).toContain('org/issues')
})

test('GitHub Issues with no repo on GitHub fails with a clear message', async () => {
  const checks = await checkConnectors({ ...cfg, extraChecks: [], tickets: { provider: 'github' } }, quiet)
  expect(checks.find((c) => c.id === 'github-issues')).toMatchObject({ ok: false })
})

test('manual tickets need no connector', async () => {
  const checks = await checkConnectors({ ...cfg, extraChecks: [], tickets: { provider: 'manual' } }, quiet)
  expect(checks.map((c) => c.id).filter((id) => id === 'linear' || id === 'github-issues')).toEqual([])
})
