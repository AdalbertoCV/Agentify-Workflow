import { expect, test, vi } from 'vitest'
import {
  activeRun,
  commentKind,
  deskStatus,
  fireRoutine,
  iterationsToday,
  shouldIterate,
  type BotRun
} from '../src/main/core/bots'

const prefix = 'Nova-Bot ·'
const at = (min: number): string => new Date(Date.UTC(2026, 9, 27, 12, min)).toISOString()
const now = Date.UTC(2026, 9, 27, 12, 30)

test('bot comments are told apart from people by the prefix, with their kind', () => {
  expect(commentKind('Nova-Bot · pregunta: ¿qué moneda?', prefix)).toBe('pregunta')
  expect(commentKind('Nova-Bot · rechazo\nFalta el diseño', prefix)).toBe('rechazo')
  expect(commentKind('Nova-Bot · entrega — PR listo', prefix)).toBe('entrega')
  expect(commentKind('Nova-Bot · algo nuevo', prefix)).toBe('otro')
  expect(commentKind('Usa pesos mexicanos', prefix)).toBeNull()
})

test('red when the last bot comment asks and nobody answered after it', () => {
  const s = deskStatus({
    prefix,
    comments: [
      { body: 'Nova-Bot · veredicto: lo tomo', createdAt: at(1) },
      { body: 'Nova-Bot · pregunta: ¿el filtro va en la URL?', createdAt: at(10) }
    ],
    now
  })
  expect(s.status).toBe('needs-you')
  expect(s.question).toContain('¿el filtro va en la URL?')
  // The kind word is for the app; the person reads only what the bot said.
  expect(s.question).toBe('¿el filtro va en la URL?')
})

test('a person answering turns red back to working', () => {
  const s = deskStatus({
    prefix,
    comments: [
      { body: 'Nova-Bot · pregunta: ¿el filtro va en la URL?', createdAt: at(10) },
      { body: 'Sí, como ?status=', createdAt: at(12) }
    ],
    lastFiredAt: at(12),
    now
  })
  expect(s.status).toBe('working')
})

test('green when the PR ready check passed; the bubble names the PR', () => {
  const s = deskStatus({
    prefix,
    comments: [{ body: 'Nova-Bot · entrega: https://github.com/o/r/pull/7', createdAt: at(20) }],
    pr: { url: 'https://github.com/o/r/pull/7', number: 7, ciFailed: false, ready: 'success', readyTitle: 'Listo para merge' },
    now
  })
  expect(s.status).toBe('done')
  expect(s.bubble).toContain('PR #7')
})

test('grey when nothing moved for three hours after the last fire', () => {
  const s = deskStatus({ prefix, comments: [], lastFiredAt: new Date(now - 4 * 3600_000).toISOString(), now })
  expect(s.status).toBe('idle')
})

test('a run is active until the bot comments after it, or for 90 minutes', () => {
  const runs: BotRun[] = [
    { id: 'r1', botId: 'b', ticket: 'T-1', kind: 'start', firedAt: at(0), sessionId: 's', sessionUrl: 'u', text: '' }
  ]
  expect(activeRun(runs, 'T-1', [], now)).toBeTruthy()
  expect(activeRun(runs, 'T-1', [{ body: 'Nova-Bot · entrega', createdAt: at(5) }], now, prefix)).toBeNull()
  expect(activeRun(runs, 'T-1', [], now + 91 * 60_000)).toBeNull()
  expect(activeRun(runs, 'T-2', [], now)).toBeNull()
})

test('iterate when CI or the ready check failed, no run is active, under the daily cap', () => {
  const failing = { url: 'u', number: 1, ciFailed: true, ready: 'success' as const }
  expect(shouldIterate({ pr: failing, active: false, iterationsToday: 0 })).toBe(true)
  expect(shouldIterate({ pr: failing, active: true, iterationsToday: 0 })).toBe(false)
  expect(shouldIterate({ pr: failing, active: false, iterationsToday: 3 })).toBe(false)
  expect(shouldIterate({ pr: { ...failing, ciFailed: false, ready: 'failure' }, active: false, iterationsToday: 0 })).toBe(true)
  expect(shouldIterate({ pr: { ...failing, ciFailed: false, ready: 'pending' }, active: false, iterationsToday: 0 })).toBe(false)
})

test('iterations are counted per ticket for the current day', () => {
  const run = (firedAt: string, kind: BotRun['kind']): BotRun => ({
    id: firedAt, botId: 'b', ticket: 'T-1', kind, firedAt, sessionId: 's', sessionUrl: 'u', text: ''
  })
  const runs = [run(at(1), 'iterate'), run(at(2), 'iterate'), run(at(3), 'start'), run('2026-10-26T12:00:00.000Z', 'iterate')]
  expect(iterationsToday(runs, 'T-1', now)).toBe(2)
})

test('firing a routine sends the text and returns the cloud session', async () => {
  const fetchFn = vi.fn(async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => ({ type: 'routine_fire', claude_code_session_id: 'session_1', claude_code_session_url: 'https://claude.ai/code/session_1' })
  }))
  const r = await fireRoutine('trig_abc', 'sk-ant-oat01-x', 'Ticket: T-1', fetchFn as unknown as typeof fetch)
  expect(r).toEqual({ sessionId: 'session_1', sessionUrl: 'https://claude.ai/code/session_1' })
  const [url, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit]
  expect(url).toBe('https://api.anthropic.com/v1/claude_code/routines/trig_abc/fire')
  const headers = init.headers as Record<string, string>
  expect(headers.Authorization).toBe('Bearer sk-ant-oat01-x')
  expect(headers['anthropic-version']).toBeTruthy()
  expect(JSON.parse(init.body as string)).toEqual({ text: 'Ticket: T-1' })
})

test('firing explains rate limits and paused routines', async () => {
  const reply = (status: number, headers: Record<string, string> = {}) =>
    vi.fn(async () => ({ ok: false, status, headers: new Headers(headers), json: async () => ({}), text: async () => '' }))
  await expect(fireRoutine('trig', 'tok', 'x', reply(429, { 'retry-after': '120' }) as unknown as typeof fetch)).rejects.toThrow(/2 min/)
  await expect(fireRoutine('trig', 'tok', 'x', reply(400) as unknown as typeof fetch)).rejects.toThrow(/pausa/)
  await expect(fireRoutine('trig', 'tok', 'x', reply(401) as unknown as typeof fetch)).rejects.toThrow(/token/)
})
