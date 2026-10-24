import { expect, test, vi } from 'vitest'
import { listMyIssues, parseReposLine } from '../src/main/core/linear'

const known = ['api', 'web', 'workers']

test('parseReposLine reads the Repos line in order', () => {
  expect(parseReposLine('Intro\n> **Repos:** api → web\n', known)).toEqual(['api', 'web'])
})

test('parseReposLine ignores unknown names and duplicates', () => {
  expect(parseReposLine('**Repos:** workers, other-repo + workers', known)).toEqual(['workers'])
})

test('parseReposLine without the line returns nothing', () => {
  expect(parseReposLine('no repos here', known)).toEqual([])
})

test('listMyIssues maps the GraphQL response', async () => {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      data: {
        viewer: {
          assignedIssues: {
            nodes: [
              {
                identifier: 'TCK-1',
                title: 'Something',
                description: null,
                url: 'https://linear.app/acme/issue/TCK-1',
                state: { name: 'In Progress', type: 'started' },
                inverseRelations: { nodes: [] }
              },
              {
                identifier: 'TCK-2',
                title: 'Waits for TCK-1',
                description: 'x',
                url: 'https://linear.app/acme/issue/TCK-2',
                state: { name: 'Backlog', type: 'backlog' },
                inverseRelations: {
                  nodes: [{ type: 'blocks', issue: { identifier: 'TCK-1', state: { type: 'started' } } }]
                }
              }
            ]
          }
        }
      }
    })
  }))
  const issues = await listMyIssues('key', fetchFn as unknown as typeof fetch)
  expect(issues).toEqual([
    {
      identifier: 'TCK-1',
      title: 'Something',
      state: 'In Progress',
      description: '',
      url: 'https://linear.app/acme/issue/TCK-1',
      status: 'in-progress'
    },
    {
      identifier: 'TCK-2',
      title: 'Waits for TCK-1',
      state: 'Backlog',
      description: 'x',
      url: 'https://linear.app/acme/issue/TCK-2',
      status: 'blocked',
      blockedBy: ['TCK-1']
    }
  ])
  // Linear rejects queries over 10000 complexity: relations must be bounded.
  const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string).query
  expect(body).toMatch(/inverseRelations\(first: \d+\)/)
  const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect((init.headers as Record<string, string>).Authorization).toBe('key')
})
