import { expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { githubRepos, githubReposFor, githubSlug, githubTicketId, listGithubIssues } from '../src/main/core/github'
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

test('listGithubIssues asks gh for my open issues of each repo', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git' }, ['org/issues'])
  const calls: string[][] = []
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args)
    const slug = args[args.indexOf('-R') + 1]
    return JSON.stringify([
      { number: 7, title: `t-${slug}`, body: 'x', url: `https://github.com/${slug}/issues/7`, state: 'OPEN' }
    ])
  }
  const issues = await listGithubIssues(cfg, gh)
  expect(calls[0]).toEqual(
    expect.arrayContaining(['issue', 'list', '-R', 'org/api', '--assignee', '@me', '--state', 'open'])
  )
  expect(issues.map((i) => [i.identifier, i.title, i.repo])).toEqual([
    ['api#7', 't-org/api', 'api'],
    ['org/issues#7', 't-org/issues', undefined]
  ])
})

test('listGithubIssues skips a failing repo when others answer, fails when none do', async () => {
  const cfg = cfgWith({ api: 'https://github.com/org/api.git' }, ['org/gone'])
  const gh = async (args: string[]): Promise<string> => {
    if (args.includes('org/gone')) throw new Error('repo not found')
    return '[]'
  }
  expect(await listGithubIssues(cfg, gh)).toEqual([])
  await expect(listGithubIssues(cfg, async () => Promise.reject(new Error('gh: not logged in')))).rejects.toThrow(
    'not logged in'
  )
})

test('suggested repos: the Repos line first, else the repo the issue lives in', () => {
  const known = ['api', 'web']
  const base = { identifier: 'api#1', title: '', state: '', url: '' }
  expect(githubReposFor({ ...base, description: '**Repos:** web', repo: 'api' }, known)).toEqual(['web'])
  expect(githubReposFor({ ...base, description: '', repo: 'api' }, known)).toEqual(['api'])
  expect(githubReposFor({ ...base, description: '' }, known)).toEqual([])
})
