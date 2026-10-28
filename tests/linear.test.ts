import { describe, expect, test, vi } from 'vitest'
import { addIssueLabel, commentOnIssue, labelledIssues, listMyIssues, parseReposLine } from '../src/main/core/linear'

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

describe('bots', () => {
  const reply = (data: unknown) =>
    vi.fn(async () => ({ ok: true, json: async () => ({ data }) }))

  test('labelledIssues reads open issues with the label, their comments and PR attachments', async () => {
    const fetchFn = reply({
      issues: {
        nodes: [
          {
            id: 'uuid-1',
            identifier: 'TCK-9',
            title: 'Filtrar',
            url: 'https://linear.app/x/TCK-9',
            state: { name: 'In Progress', type: 'started' },
            comments: { nodes: [{ body: 'Bot · lo tomo', createdAt: '2026-10-27T10:00:00Z' }] },
            attachments: { nodes: [{ url: 'https://github.com/o/r/pull/7' }, { url: 'https://figma.com/x' }] }
          }
        ]
      }
    })
    const issues = await labelledIssues('key', 'bot', fetchFn as unknown as typeof fetch)
    expect(issues).toEqual([
      {
        id: 'uuid-1',
        identifier: 'TCK-9',
        title: 'Filtrar',
        url: 'https://linear.app/x/TCK-9',
        state: 'In Progress',
        comments: [{ body: 'Bot · lo tomo', createdAt: '2026-10-27T10:00:00Z' }],
        prUrls: ['https://github.com/o/r/pull/7']
      }
    ])
    const body = JSON.parse((fetchFn.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body.variables).toEqual({ label: 'bot' })
  })

  test('labelling an issue looks the label up by name, then adds it', async () => {
    const calls: { query: string; variables: Record<string, string> }[] = []
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string)
      calls.push(b)
      const data = b.query.includes('issueLabels')
        ? { issueLabels: { nodes: [{ id: 'label-1' }] }, issue: { id: 'uuid-1' } }
        : { issueAddLabel: { success: true } }
      return { ok: true, json: async () => ({ data }) }
    })
    await addIssueLabel('key', 'TCK-9', 'bot', fetchFn as unknown as typeof fetch)
    expect(calls[1].variables).toEqual({ id: 'uuid-1', labelId: 'label-1' })
  })

  test('a label that does not exist says so instead of failing silently', async () => {
    const fetchFn = reply({ issueLabels: { nodes: [] }, issue: { id: 'uuid-1' } })
    await expect(addIssueLabel('key', 'TCK-9', 'bot', fetchFn as unknown as typeof fetch)).rejects.toThrow(/etiqueta "bot"/)
  })

  test('commenting posts the body on the issue', async () => {
    const calls: { variables: Record<string, unknown> }[] = []
    const fetchFn = vi.fn(async (_u: string, init: RequestInit) => {
      const b = JSON.parse(init.body as string)
      calls.push(b)
      return { ok: true, json: async () => ({ data: b.query.includes('commentCreate') ? { commentCreate: { success: true } } : { issue: { id: 'uuid-1' } } }) }
    })
    await commentOnIssue('key', 'TCK-9', 'Sí, en la URL', fetchFn as unknown as typeof fetch)
    expect(calls[1].variables).toEqual({ input: { issueId: 'uuid-1', body: 'Sí, en la URL' } })
  })
})
