import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Cloud bots: Claude Code routines that work tickets on their own, each run in its own sandbox.
 * There is no API to read a run, so where a bot stands is read from what it leaves behind: its
 * prefixed comments on the ticket and the checks on its PR.
 */
export type BotConfig = {
  id: string
  name: string
  avatar?: string
  routineId: string
  /** Ticket label that means "this bot works it". */
  label: string
  /** Text its comments start with, e.g. "Adal-Bot ·". */
  commentPrefix: string
  /** PR check that means "ready to merge". */
  readyCheck?: string
  autoIterate?: boolean
}

export type BotRun = {
  id: string
  botId: string
  ticket: string
  kind: 'start' | 'answer' | 'iterate'
  firedAt: string
  sessionId: string
  sessionUrl: string
  text: string
}

/** Desks the user put away, and when: one comes back if its bot speaks again after that. */
export type BotsStore = { runs: BotRun[]; dismissed: { key: string; at: string }[] }
export type Comment = { body: string; createdAt: string }
export type CheckState = 'success' | 'failure' | 'pending' | 'missing'
export type PrState = {
  url: string
  number: number
  ciFailed: boolean
  ready: CheckState
  readyTitle?: string
  merged?: boolean
}
export type DeskState = 'working' | 'done' | 'needs-you' | 'idle'

const ACTIVE_MS = 90 * 60_000
const IDLE_MS = 3 * 3600_000
export const MAX_ITERATIONS_PER_DAY = 3

export function storeFile(root: string): string {
  return join(root, '.agentify', 'bots.json')
}

export function readStore(root: string): BotsStore {
  const f = storeFile(root)
  if (!existsSync(f)) return { runs: [], dismissed: [] }
  const raw = JSON.parse(readFileSync(f, 'utf8'))
  return {
    runs: Array.isArray(raw.runs) ? raw.runs : [],
    dismissed: Array.isArray(raw.dismissed)
      ? raw.dismissed.filter((d: { key?: string }) => d?.key)
      : []
  }
}

export function writeStore(root: string, store: BotsStore): void {
  const f = storeFile(root)
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(store, null, 2) + '\n')
}

/** Null for a person's comment; otherwise what the bot said it was doing. */
export function commentKind(
  body: string,
  prefix: string
): 'pregunta' | 'rechazo' | 'veredicto' | 'entrega' | 'otro' | null {
  const text = body.trimStart()
  if (!text.startsWith(prefix)) return null
  const word = /^\s*(pregunta|rechazo|veredicto|entrega)\b/i
    .exec(text.slice(prefix.length))?.[1]
    ?.toLowerCase()
  return (word as 'pregunta' | 'rechazo' | 'veredicto' | 'entrega' | undefined) ?? 'otro'
}

function plain(body: string, prefix: string): string {
  return body
    .trimStart()
    .slice(body.trimStart().startsWith(prefix) ? prefix.length : 0)
    .replace(/[*_`#>]/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^(pregunta|rechazo|veredicto|entrega)\b\s*[:—-]?\s*/i, '')
}

/** The traffic light and the speech bubble of a desk. */
export function deskStatus(input: {
  prefix: string
  comments: Comment[]
  pr?: PrState
  lastFiredAt?: string
  now: number
}): { status: DeskState; bubble: string; question?: string } {
  const sorted = [...input.comments].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const lastBot = [...sorted].reverse().find((c) => commentKind(c.body, input.prefix))
  const kind = lastBot && commentKind(lastBot.body, input.prefix)
  const answeredAfter =
    lastBot &&
    sorted.some((c) => c.createdAt > lastBot.createdAt && !commentKind(c.body, input.prefix))
  const prLine = input.pr
    ? `PR #${input.pr.number}: CI ${input.pr.ciFailed ? '✗' : '✓'}` +
      (input.pr.ready === 'missing'
        ? ''
        : `, revisión ${input.pr.ready === 'success' ? '✓' : input.pr.ready === 'failure' ? '✗' : '…'}`) +
      (input.pr.readyTitle ? ` (${input.pr.readyTitle})` : '')
    : ''
  const said = lastBot ? plain(lastBot.body, input.prefix) : ''
  const short = said.length > 180 ? `${said.slice(0, 177)}…` : said

  if (lastBot && (kind === 'pregunta' || kind === 'rechazo') && !answeredAfter)
    return { status: 'needs-you', bubble: short, question: said }
  if (input.pr && input.pr.ready === 'success' && !input.pr.ciFailed)
    return {
      status: 'done',
      bubble: [prLine, short].filter(Boolean).join(' · ') || 'Listo para merge'
    }
  const lastActivity = [lastBot?.createdAt, input.lastFiredAt].filter(Boolean).sort().at(-1)
  if (lastActivity && input.now - Date.parse(lastActivity) > IDLE_MS && !input.pr)
    return { status: 'idle', bubble: short || 'Sin actividad del bot en las últimas horas' }
  return { status: 'working', bubble: [short || 'Trabajando…', prLine].filter(Boolean).join(' · ') }
}

/** The run still at work on a ticket: fired under 90 min ago with no bot comment since. */
export function activeRun(
  runs: BotRun[],
  ticket: string,
  comments: Comment[],
  now: number,
  prefix = ''
): BotRun | null {
  const last = runs
    .filter((r) => r.ticket === ticket)
    .sort((a, b) => a.firedAt.localeCompare(b.firedAt))
    .at(-1)
  if (!last || now - Date.parse(last.firedAt) > ACTIVE_MS) return null
  const botSpokeSince =
    prefix && comments.some((c) => c.createdAt > last.firedAt && commentKind(c.body, prefix))
  return botSpokeSince ? null : last
}

export function iterationsToday(runs: BotRun[], ticket: string, now: number): number {
  const day = new Date(now).toISOString().slice(0, 10)
  return runs.filter(
    (r) => r.ticket === ticket && r.kind === 'iterate' && r.firedAt.slice(0, 10) === day
  ).length
}

/** The app watches the PRs: one iteration at a time, never past the daily cap. */
export function shouldIterate(input: {
  pr?: PrState
  active: boolean
  iterationsToday: number
}): boolean {
  if (
    !input.pr ||
    input.pr.merged ||
    input.active ||
    input.iterationsToday >= MAX_ITERATIONS_PER_DAY
  )
    return false
  return input.pr.ciFailed || input.pr.ready === 'failure'
}

const FIRE_URL = 'https://api.anthropic.com/v1/claude_code/routines'

/** Starts a run of the routine in the cloud; `text` reaches it as its routine-fire-payload. */
export async function fireRoutine(
  routineId: string,
  token: string,
  text: string,
  fetchFn: typeof fetch = fetch
): Promise<{ sessionId: string; sessionUrl: string }> {
  const res = await fetchFn(`${process.env.AGENTIFY_ROUTINES_URL ?? FIRE_URL}/${routineId}/fire`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'experimental-cc-routine-2026-04-01',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ text })
  })
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? 60)
    throw new Error(`Límite de corridas por hora alcanzado; intenta en ${Math.ceil(wait / 60)} min`)
  }
  if (res.status === 400)
    throw new Error('La routine está en pausa o rechazó el pedido (revísala en claude.ai)')
  if (res.status === 401 || res.status === 403)
    throw new Error('El token de la routine no es válido; genera otro en claude.ai')
  if (res.status === 404) throw new Error('No existe esa routine (revisa el id trig_…)')
  if (!res.ok) throw new Error(`La routine respondió ${res.status}`)
  const body = (await res.json()) as {
    claude_code_session_id: string
    claude_code_session_url: string
  }
  return { sessionId: body.claude_code_session_id, sessionUrl: body.claude_code_session_url }
}
