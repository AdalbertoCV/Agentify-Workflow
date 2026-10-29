import { expect, test } from 'vitest'
import type { BotConfig, BotsStore, PrState } from '../src/main/core/bots'
import type { LabelledIssue } from '../src/main/core/linear'
import { buildDesks, planIterations } from '../src/main/core/office'

const bot: BotConfig = {
  id: 'b',
  name: 'Bot',
  avatar: '🤖',
  routineId: 'trig_1',
  label: 'bot',
  commentPrefix: 'Bot ·',
  readyCheck: 'review · ready',
  autoIterate: true
}
const at = (min: number): string => new Date(Date.UTC(2026, 9, 27, 12, min)).toISOString()
const now = Date.UTC(2026, 9, 27, 12, 30)
const issue = (identifier: string, extra: Partial<LabelledIssue> = {}): LabelledIssue => ({
  id: `uuid-${identifier}`,
  identifier,
  title: `Título ${identifier}`,
  url: `https://linear.app/x/${identifier}`,
  state: 'In Progress',
  comments: [],
  prUrls: [],
  ...extra
})
const empty: BotsStore = { runs: [], dismissed: [] }
const run = (ticket: string, min: number, botId = 'b'): BotsStore['runs'][number] => ({
  id: `${botId}-${ticket}-${min}`,
  botId,
  ticket,
  kind: 'start',
  firedAt: at(min),
  sessionId: 's',
  sessionUrl: 'u',
  text: ''
})

test('one desk per ticket the bot was fired on, with status, bubble and the latest session link', async () => {
  const store: BotsStore = {
    runs: [
      {
        id: 'r',
        botId: 'b',
        ticket: 'T-1',
        kind: 'start',
        firedAt: at(1),
        sessionId: 's1',
        sessionUrl: 'https://claude.ai/code/s1',
        text: ''
      }
    ],
    dismissed: []
  }
  const desks = await buildDesks([bot], {
    issues: async () => [
      issue('T-1', { comments: [{ body: 'Bot · pregunta: ¿pesos o dólares?', createdAt: at(5) }] }),
      issue('T-2')
    ],
    pr: async () => undefined,
    store,
    now
  })
  // T-2 only carries the label: nobody fired the bot on it, so it is not at work.
  expect(desks.map((d) => [d.key, d.status, d.sessionUrl])).toEqual([
    ['b:T-1', 'needs-you', 'https://claude.ai/code/s1']
  ])
  expect(desks[0].question).toContain('¿pesos o dólares?')
  expect(desks[0].avatar).toBe('🤖')
})

test('the PR comes from the issue attachments, or else from a link in the bot comments', async () => {
  const seen: string[] = []
  await buildDesks([bot], {
    issues: async () => [
      issue('T-1', { prUrls: ['https://github.com/o/r/pull/1'] }),
      issue('T-2', {
        comments: [{ body: 'Bot · entrega: https://github.com/o/r/pull/2 listo', createdAt: at(3) }]
      })
    ],
    pr: async (url) => {
      seen.push(url)
      return undefined
    },
    store: { runs: [run('T-1', 1)], dismissed: [] },
    now
  })
  expect(seen).toEqual(['https://github.com/o/r/pull/1', 'https://github.com/o/r/pull/2'])
})

test('a dismissed desk stays away until its bot speaks again', async () => {
  const store: BotsStore = { runs: [], dismissed: [{ key: 'b:T-1', at: at(10) }] }
  const quiet = await buildDesks([bot], {
    issues: async () => [
      issue('T-1', { comments: [{ body: 'Bot · veredicto: lo tomo', createdAt: at(5) }] })
    ],
    pr: async () => undefined,
    store,
    now
  })
  expect(quiet).toEqual([])
  const spoke = await buildDesks([bot], {
    issues: async () => [
      issue('T-1', { comments: [{ body: 'Bot · pregunta: ¿y esto?', createdAt: at(20) }] })
    ],
    pr: async () => undefined,
    store,
    now
  })
  expect(spoke.map((d) => d.key)).toEqual(['b:T-1'])
})

test('a dismissed desk comes back when the bot is fired on it again', async () => {
  const issues = async (): Promise<LabelledIssue[]> => [issue('T-1')]
  const dismissed = [{ key: 'b:T-1', at: at(10) }]
  const before = await buildDesks([bot], {
    issues,
    pr: async () => undefined,
    store: { runs: [run('T-1', 5)], dismissed },
    now
  })
  expect(before).toEqual([])
  const fired = await buildDesks([bot], {
    issues,
    pr: async () => undefined,
    store: { runs: [run('T-1', 5), run('T-1', 20)], dismissed },
    now
  })
  expect(fired.map((d) => [d.key, d.status, d.active])).toEqual([['b:T-1', 'working', true]])
})

test('iterations are planned only for bots that auto-iterate, one per ticket, with the reason', async () => {
  const red: PrState = {
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    ciFailed: false,
    ready: 'failure',
    readyTitle: '2 hallazgos'
  }
  const desks = await buildDesks(
    [bot, { ...bot, id: 'quiet', label: 'quiet', autoIterate: false }],
    {
      issues: async (label) => [issue(label === 'bot' ? 'T-1' : 'T-9', { prUrls: [red.url] })],
      pr: async () => red,
      store: { runs: [run('T-1', -200), run('T-9', -200, 'quiet')], dismissed: [] },
      now
    }
  )
  const plan = planIterations(
    [bot, { ...bot, id: 'quiet', label: 'quiet', autoIterate: false }],
    desks,
    empty,
    now
  )
  expect(plan).toEqual([
    {
      botId: 'b',
      ticket: 'T-1',
      text: 'Ticket: T-1\nItera el PR https://github.com/o/r/pull/1: la revisión está en rojo (2 hallazgos)'
    }
  ])
})

test('past the daily cap of automatic iterations, a red PR asks the user instead', async () => {
  const red: PrState = {
    url: 'https://github.com/o/r/pull/1',
    number: 1,
    ciFailed: true,
    ready: 'success'
  }
  const iter = (min: number) => ({
    id: `i${min}`,
    botId: 'b',
    ticket: 'T-1',
    kind: 'iterate' as const,
    firedAt: at(min - 200),
    sessionId: 's',
    sessionUrl: 'u',
    text: ''
  })
  const store: BotsStore = {
    runs: [iter(10), iter(11), iter(12)].map((r, i) => ({
      ...r,
      firedAt: new Date(now - (5 - i) * 3600_000).toISOString()
    })),
    dismissed: []
  }
  const [desk] = await buildDesks([bot], {
    issues: async () => [issue('T-1', { prUrls: [red.url] })],
    pr: async () => red,
    store,
    now
  })
  expect(desk.status).toBe('needs-you')
  expect(desk.capped).toBe(true)
  expect(planIterations([bot], [desk], store, now)).toEqual([])
})

test('bots sharing a label split its tickets: each one sits at the desk of the bot that last worked it', async () => {
  const twin: BotConfig = {
    ...bot,
    id: 'c',
    name: 'Twin',
    routineId: 'trig_2',
    commentPrefix: 'Twin ·'
  }
  const store: BotsStore = {
    runs: [
      {
        id: 'r',
        botId: 'c',
        ticket: 'T-1',
        kind: 'start',
        firedAt: at(1),
        sessionId: 's',
        sessionUrl: 'u',
        text: ''
      }
    ],
    dismissed: []
  }
  const asked: string[] = []
  const desks = await buildDesks([bot, twin], {
    issues: async (label) => {
      asked.push(label)
      return [
        issue('T-1'),
        issue('T-2', { comments: [{ body: 'Twin · veredicto: lo tomo', createdAt: at(2) }] }),
        issue('T-3', {
          comments: [
            { body: 'Twin · entrega: listo', createdAt: at(2) },
            { body: 'Bot · iteración: CI verde', createdAt: at(9) }
          ]
        }),
        issue('T-4')
      ]
    },
    pr: async () => undefined,
    store,
    now
  })
  expect(desks.map((d) => d.key).sort()).toEqual(['b:T-3', 'c:T-1', 'c:T-2'])
  expect(asked).toEqual(['bot'])
})
