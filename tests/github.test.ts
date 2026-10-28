import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { githubRepos, githubReposFor, githubSlug, githubTicketId, listGithubIssues, prState } from '../src/main/core/github'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

function cfgWith(remotes: Record<string, string>, extra: string[] = []): AppConfig {
  const root = tempDir()
  const repos = Object.entries(remotes).map(([name, url]) => {
    const { clone } = makeOriginAndClone(root, 'main', name)
    git(clone, 'remote', 'set-url', 'origin', url)
    return { name, path: clone, trunk: 'main', copyFiles: [], linkDirs: [], setup: [] }
  })
  return {
    root,
    branchPrefix: 'p',
    repos,
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude',
    tickets: { provider: 'github', githubRepos: extra }
  }
}

test('githubSlug reads https and ssh remotes and ignores other hosts', () => {
  expect(githubSlug('https://github.com/org/api.git')).toBe('org/api')
  expect(githubSlug('https://github.com/org/api')).toBe('org/api')
  expect(githubSlug('git@github.com:org/web.git')).toBe('org/web')
  expect(githubSlug('https://gitlab.com/org/api.git')).toBeNull()
  expect(githubSlug('C:/repos/api-origin.git')).toBeNull()
})

test('githubRepos lists the config repos on GitHub plus the extra repos', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git', web: 'https://gitlab.com/org/web.git' }, ['org/issues'])
  expect(await githubRepos(cfg)).toEqual([{ slug: 'org/api', repo: 'api' }, { slug: 'org/issues' }])
})

test('ticket ids: config repos by name, extra repos with their owner', () => {
  expect(githubTicketId('org/api', 123, 'api')).toBe('api#123')
  expect(githubTicketId('org/issues', 45)).toBe('org/issues#45')
})

/** A fake gh: `api user` gives the login, `api graphql` answers per repo with `issues(slug)`. */
function fakeGh(issues: (slug: string) => unknown[], calls: string[][] = []): (args: string[]) => Promise<string> {
  return async (args) => {
    calls.push(args)
    if (args[1] === 'user') return 'me\n'
    const field = (k: string): string => args.find((a) => a.startsWith(`${k}=`))!.slice(k.length + 1)
    const slug = `${field('owner')}/${field('name')}`
    return JSON.stringify({ data: { repository: { issues: { nodes: issues(slug) } } } })
  }
}

const node = (slug: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  number: 7,
  title: `t-${slug}`,
  body: 'x',
  url: `https://github.com/${slug}/issues/7`,
  labels: { nodes: [] },
  blockedBy: { nodes: [] },
  ...extra
})

test('listGithubIssues asks GitHub for my open issues of each repo', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git' }, ['org/issues'])
  const calls: string[][] = []
  const issues = await listGithubIssues(cfg, fakeGh((slug) => [node(slug)], calls))
  const query = calls.find((c) => c[1] === 'graphql')!
  expect(query).toEqual(expect.arrayContaining(['-F', 'owner=org', '-F', 'name=api', '-F', 'login=me']))
  expect(query.find((a) => a.startsWith('query='))).toMatch(/states: OPEN/)
  expect(query.find((a) => a.startsWith('query='))).not.toContain(String.fromCharCode(10))
  expect(issues.map((i) => [i.identifier, i.title, i.repo, i.status])).toEqual([
    ['api#7', 't-org/api', 'api', 'ready'],
    ['org/issues#7', 't-org/issues', undefined, 'ready']
  ])
})

test('an issue blocked by an open issue says which one; labels give progress and review', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git' })
  const issues = await listGithubIssues(
    cfg,
    fakeGh(() => [
      node('org/api', {
        number: 1,
        blockedBy: { nodes: [{ number: 3, state: 'OPEN', repository: { nameWithOwner: 'org/api' } }] }
      }),
      node('org/api', {
        number: 2,
        blockedBy: { nodes: [{ number: 4, state: 'CLOSED', repository: { nameWithOwner: 'org/api' } }] }
      }),
      node('org/api', { number: 5, labels: { nodes: [{ name: 'in review' }] } })
    ])
  )
  expect(issues.map((i) => [i.identifier, i.status, i.blockedBy])).toEqual([
    ['api#1', 'blocked', ['org/api#3']],
    ['api#2', 'ready', undefined],
    ['api#5', 'in-review', undefined]
  ])
})

test('listGithubIssues skips a failing repo when others answer, fails when none do', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git' }, ['org/gone'])
  const ok = fakeGh(() => [])
  const gh = async (args: string[]): Promise<string> => {
    if (args.includes('name=gone')) throw new Error('repo not found')
    return ok(args)
  }
  expect(await listGithubIssues(cfg, gh)).toEqual([])
  await expect(listGithubIssues(cfg, async () => Promise.reject(new Error('gh: not logged in')))).rejects.toThrow(
    'not logged in'
  )
})

test('suggested repos: the Repos line first, else the repo the issue lives in', () => {
  const known = ['api', 'web']
  const base = { identifier: 'api#1', title: '', state: '', url: '', status: 'ready' as const }
  expect(githubReposFor({ ...base, description: '**Repos:** web', repo: 'api' }, known)).toEqual(['web'])
  expect(githubReposFor({ ...base, description: '', repo: 'api' }, known)).toEqual(['api'])
  expect(githubReposFor({ ...base, description: '' }, known)).toEqual([])
})

test('prState reads CI, the ready check and its summary title', async () => {
  const calls: string[][] = []
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args)
    if (args[0] === 'pr')
      return JSON.stringify({
        number: 7,
        state: 'OPEN',
        headRefOid: 'abc123',
        statusCheckRollup: [
          { __typename: 'CheckRun', name: 'tests', status: 'COMPLETED', conclusion: 'SUCCESS' },
          { __typename: 'CheckRun', name: 'review · ready', status: 'COMPLETED', conclusion: 'FAILURE' },
          { __typename: 'StatusContext', context: 'vercel', state: 'SUCCESS' }
        ]
      })
    return JSON.stringify({ check_runs: [{ name: 'review · ready', output: { title: '2 hallazgos bloqueantes' } }] })
  }
  const s = await prState('https://github.com/o/r/pull/7', 'review · ready', gh)
  expect(s).toEqual({
    url: 'https://github.com/o/r/pull/7',
    number: 7,
    ciFailed: false,
    ready: 'failure',
    readyTitle: '2 hallazgos bloqueantes',
    merged: false
  })
  expect(calls[1]).toEqual(['api', 'repos/o/r/commits/abc123/check-runs'])
})

test('a failed CI check or status context counts as CI failed; no ready check is missing', async () => {
  const gh = async (args: string[]): Promise<string> =>
    args[0] === 'pr'
      ? JSON.stringify({
          number: 8,
          state: 'MERGED',
          headRefOid: 'def',
          statusCheckRollup: [{ __typename: 'StatusContext', context: 'ci', state: 'ERROR' }]
        })
      : '{"check_runs":[]}'
  const s = await prState('https://github.com/o/r/pull/8', 'review · ready', gh)
  expect(s).toMatchObject({ ciFailed: true, ready: 'missing', merged: true })
})
