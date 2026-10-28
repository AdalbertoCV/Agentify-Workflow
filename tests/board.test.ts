import { expect, test } from 'vitest'
import type { BotConfig } from '../src/main/core/bots'
import { buildBoard, type BoardIssue } from '../src/main/core/board'
import { boardIssues } from '../src/main/core/linear'
import type { Desk } from '../src/main/core/office'

const states = [
  { name: 'Done', type: 'completed', position: 5, color: '#5e6ad2' },
  { name: 'In Review', type: 'started', position: 4, color: '#0f0' },
  { name: 'Canceled', type: 'canceled', position: 6, color: '#999' },
  { name: 'Duplicate', type: 'duplicate', position: 7, color: '#999' },
  { name: 'Todo', type: 'unstarted', position: 2, color: '#fff' },
  { name: 'Backlog', type: 'backlog', position: 1, color: '#bbb' },
  { name: 'In Progress', type: 'started', position: 3, color: '#ff0' },
  { name: 'Triage', type: 'triage', position: 0, color: '#f80' }
]
const card = (identifier: string, extra: Partial<BoardIssue> = {}): BoardIssue => ({
  identifier,
  title: `Título ${identifier}`,
  description: '',
  url: `https://linear.app/x/${identifier}`,
  state: 'Todo',
  status: 'ready',
  priority: 0,
  labels: [],
  team: 'T',
  updatedAt: '2026-10-01T00:00:00Z',
  ...extra
})
const bot: BotConfig = {
  id: 'b',
  name: 'Bot',
  avatar: '🤖',
  routineId: 'trig_1',
  label: 'bot',
  commentPrefix: 'Bot ·'
}
const twin: BotConfig = { ...bot, id: 'c', name: 'Twin', avatar: '🐱', commentPrefix: 'Twin ·' }

test('columns follow the team workflow, without canceled or duplicate and with triage only when it has tickets', () => {
  const board = buildBoard([card('T-1')], [{ key: 'T', states }], [], [])
  expect(board.map((c) => c.name)).toEqual(['Backlog', 'Todo', 'In Progress', 'In Review', 'Done'])
  const withTriage = buildBoard([card('T-1', { state: 'Triage' })], [{ key: 'T', states }], [], [])
  expect(withTriage[0].name).toBe('Triage')
})

test('cards sit in their state, most urgent first and priority none last', () => {
  const board = buildBoard(
    [
      card('T-1', { priority: 0 }),
      card('T-2', { priority: 3 }),
      card('T-3', { priority: 1 }),
      card('T-4', { state: 'In Progress', status: 'in-progress' })
    ],
    [{ key: 'T', states }],
    [],
    []
  )
  expect(board.find((c) => c.name === 'Todo')!.cards.map((c) => c.identifier)).toEqual([
    'T-3',
    'T-2',
    'T-1'
  ])
  expect(board.find((c) => c.name === 'In Progress')!.cards.map((c) => c.identifier)).toEqual([
    'T-4'
  ])
})

test('only the teams with your tickets give columns, and a state no team lists still shows', () => {
  const other = [{ name: 'Icebox', type: 'backlog', position: 0, color: '#000' }]
  const board = buildBoard(
    [card('T-1'), card('T-2', { state: 'Limbo' })],
    [
      { key: 'T', states },
      { key: 'O', states: other }
    ],
    [],
    []
  )
  expect(board.map((c) => c.name)).not.toContain('Icebox')
  expect(board.at(-1)!.name).toBe('Limbo')
  expect(board.at(-1)!.cards.map((c) => c.identifier)).toEqual(['T-2'])
})

test('a ticket with a bot label carries that bot, and its desk light when the Office has one', () => {
  const desk = { ticket: 'T-2', botId: 'c', status: 'needs-you' } as Desk
  const board = buildBoard(
    [card('T-1', { labels: ['Bot'] }), card('T-2', { labels: ['bot'] }), card('T-3')],
    [{ key: 'T', states }],
    [bot, twin],
    [desk]
  )
  const todo = board.find((c) => c.name === 'Todo')!.cards
  expect(todo.find((c) => c.identifier === 'T-1')!.bot).toEqual({
    id: 'b',
    name: 'Bot',
    avatar: '🤖',
    label: 'bot'
  })
  expect(todo.find((c) => c.identifier === 'T-2')!.bot).toEqual({
    id: 'c',
    name: 'Twin',
    avatar: '🐱',
    label: 'bot',
    status: 'needs-you'
  })
  expect(todo.find((c) => c.identifier === 'T-3')!.bot).toBeUndefined()
})

test('boardIssues reads your open tickets and, apart, the ones done in the last 14 days, and your teams', async () => {
  let sent = ''
  const fetchFn = (async (_url: string, init: RequestInit) => {
    sent = JSON.parse(init.body as string).query
    return new Response(
      JSON.stringify({
        data: {
          viewer: {
            teams: { nodes: [{ key: 'T', states: { nodes: states } }] },
            done: { nodes: [] },
            open: {
              nodes: [
                {
                  identifier: 'T-1',
                  title: 'Uno',
                  description: null,
                  url: 'u',
                  priority: 2,
                  updatedAt: '2026-10-01T00:00:00Z',
                  team: { key: 'T' },
                  labels: { nodes: [{ name: 'bot' }] },
                  state: { name: 'Todo', type: 'unstarted' },
                  inverseRelations: {
                    nodes: [
                      { type: 'blocks', issue: { identifier: 'T-9', state: { type: 'started' } } }
                    ]
                  }
                }
              ]
            }
          }
        }
      })
    )
  }) as typeof fetch
  const { issues, teams } = await boardIssues('key', fetchFn)
  expect(sent).toMatch(/open: assignedIssues/)
  expect(sent).toMatch(/done: assignedIssues[^]*-P14D/)
  expect(teams).toEqual([{ key: 'T', states }])
  expect(issues).toEqual([
    {
      identifier: 'T-1',
      title: 'Uno',
      description: '',
      url: 'u',
      state: 'Todo',
      status: 'blocked',
      blockedBy: ['T-9'],
      priority: 2,
      labels: ['bot'],
      team: 'T',
      updatedAt: '2026-10-01T00:00:00Z'
    }
  ])
})
