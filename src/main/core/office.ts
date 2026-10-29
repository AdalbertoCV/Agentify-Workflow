import {
  activeRun,
  commentKind,
  deskStatus,
  iterationsToday,
  MAX_ITERATIONS_PER_DAY,
  shouldIterate,
  type BotConfig,
  type BotsStore,
  type DeskState,
  type PrState
} from './bots'
import type { LabelledIssue } from './linear'

/** One ticket a bot is working, as the Office shows it. */
export type Desk = {
  key: string
  botId: string
  botName: string
  avatar?: string
  ticket: string
  title: string
  ticketUrl: string
  status: DeskState
  bubble: string
  question?: string
  pr?: PrState
  sessionUrl?: string
  lastFiredAt?: string
  iterationsToday: number
  active: boolean
  /** The PR is still red after the automatic iterations of the day: the user decides. */
  capped?: boolean
}

const PR_LINK = /https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+/

export async function buildDesks(
  bots: BotConfig[],
  deps: {
    issues: (label: string) => Promise<LabelledIssue[]>
    pr: (url: string, readyCheck?: string) => Promise<PrState | undefined>
    store: BotsStore
    now: number
  }
): Promise<Desk[]> {
  const desks: Desk[] = []
  const byLabel = new Map<string, LabelledIssue[]>()
  for (const label of new Set(bots.map((b) => b.label)))
    byLabel.set(label, await deps.issues(label))
  for (const bot of bots) {
    const twins = bots.filter((b) => b.label === bot.label)
    for (const issue of byLabel.get(bot.label) ?? []) {
      if (owner(twins, issue, deps.store) !== bot) continue
      const runs = deps.store.runs.filter(
        (r) => r.botId === bot.id && r.ticket === issue.identifier
      )
      const botComments = issue.comments.filter((c) => commentKind(c.body, bot.commentPrefix))
      // The label alone is not work: a desk opens once the bot was fired on the ticket or spoke on it.
      if (!runs.length && !botComments.length) continue
      const key = `${bot.id}:${issue.identifier}`
      const dismissed = deps.store.dismissed.find((d) => d.key === key)
      const backSince =
        dismissed &&
        (botComments.some((c) => c.createdAt > dismissed.at) ||
          runs.some((r) => r.firedAt > dismissed.at))
      if (dismissed && !backSince) continue
      const prUrl =
        issue.prUrls[0] ?? botComments.map((c) => PR_LINK.exec(c.body)?.[0]).find(Boolean)
      const pr = prUrl ? await deps.pr(prUrl, bot.readyCheck).catch(() => undefined) : undefined
      const last = runs.sort((a, b) => a.firedAt.localeCompare(b.firedAt)).at(-1)
      let status = deskStatus({
        prefix: bot.commentPrefix,
        comments: issue.comments,
        pr,
        lastFiredAt: last?.firedAt,
        now: deps.now
      })
      const iterations = iterationsToday(deps.store.runs, issue.identifier, deps.now)
      const active = Boolean(
        activeRun(deps.store.runs, issue.identifier, issue.comments, deps.now, bot.commentPrefix)
      )
      const capped =
        bot.autoIterate &&
        !!pr &&
        !pr.merged &&
        (pr.ciFailed || pr.ready === 'failure') &&
        !active &&
        iterations >= MAX_ITERATIONS_PER_DAY
      if (capped && status.status !== 'needs-you')
        status = {
          status: 'needs-you',
          bubble: `El PR sigue en rojo tras ${iterations} iteraciones automáticas hoy. ¿Itero otra vez o lo ves tú?`
        }
      desks.push({
        key,
        botId: bot.id,
        botName: bot.name,
        avatar: bot.avatar,
        ticket: issue.identifier,
        title: issue.title,
        ticketUrl: issue.url,
        ...status,
        pr,
        sessionUrl: last?.sessionUrl,
        lastFiredAt: last?.firedAt,
        iterationsToday: iterations,
        active,
        capped: capped || undefined
      })
    }
  }
  return desks
}

/**
 * Bots can share a label (one label the reviewers know as "a bot's PR"): a ticket belongs to the
 * one that last fired a run on it or commented on it, and to the first of them before that.
 */
function owner(twins: BotConfig[], issue: LabelledIssue, store: BotsStore): BotConfig {
  let best = twins[0]
  let latest = ''
  for (const bot of twins) {
    const times = [
      ...store.runs
        .filter((r) => r.botId === bot.id && r.ticket === issue.identifier)
        .map((r) => r.firedAt),
      ...issue.comments
        .filter((c) => commentKind(c.body, bot.commentPrefix))
        .map((c) => c.createdAt)
    ]
    const last = times.sort().at(-1) ?? ''
    if (last > latest) [best, latest] = [bot, last]
  }
  return best
}

/** The iterations the app should fire now: red PRs of auto-iterating bots with no run at work. */
export function planIterations(
  bots: BotConfig[],
  desks: Desk[],
  store: BotsStore,
  now: number
): { botId: string; ticket: string; text: string }[] {
  return desks
    .filter((d) => bots.find((b) => b.id === d.botId)?.autoIterate)
    .filter(
      (d) =>
        d.status !== 'needs-you' &&
        shouldIterate({
          pr: d.pr,
          active: d.active,
          iterationsToday: iterationsToday(store.runs, d.ticket, now)
        })
    )
    .map((d) => ({ botId: d.botId, ticket: d.ticket, text: iterateText(d.ticket, d.pr!) }))
}

export function iterateText(ticket: string, pr: PrState): string {
  const why = [
    pr.ciFailed ? 'CI está en rojo' : '',
    pr.ready === 'failure'
      ? `la revisión está en rojo${pr.readyTitle ? ` (${pr.readyTitle})` : ''}`
      : ''
  ]
    .filter(Boolean)
    .join(' y ')
  return `Ticket: ${ticket}\nItera el PR ${pr.url}: ${why || 'revisa lo pendiente'}`
}
