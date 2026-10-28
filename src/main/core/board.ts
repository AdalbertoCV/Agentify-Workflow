import type { BotConfig, DeskState } from './bots'
import type { Issue } from './linear'
import type { Desk } from './office'

/** One of your tickets as the board shows it. */
export type BoardIssue = Issue & {
  /** Linear priority: 1 urgent … 4 low, 0 none. */
  priority: number
  labels: string[]
  team: string
  updatedAt: string
}
export type WorkflowState = { name: string; type: string; position: number; color: string }
export type TeamStates = { key: string; states: WorkflowState[] }
export type BoardCard = BoardIssue & {
  bot?: { id: string; name: string; avatar?: string; label: string; status?: DeskState }
}
export type BoardColumn = { name: string; type: string; color: string; cards: BoardCard[] }

const TYPE_ORDER = ['triage', 'backlog', 'unstarted', 'started', 'completed']

const rank = (priority: number): number => (priority === 0 ? 5 : priority)

/**
 * Columns are the workflow states of the teams your tickets belong to, in Linear's order. Canceled
 * and duplicate are left out, and triage shows only when something is in it.
 */
export function buildBoard(
  issues: BoardIssue[],
  teams: TeamStates[],
  bots: BotConfig[],
  desks: Desk[]
): BoardColumn[] {
  const mine = new Set(issues.map((i) => i.team))
  const used = teams.filter((t) => mine.has(t.key))
  const states = (used.length ? used : teams.slice(0, 1))
    .flatMap((t) => t.states)
    .filter((s) => TYPE_ORDER.includes(s.type))
    .sort(
      (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type) || a.position - b.position
    )

  const columns: BoardColumn[] = []
  for (const s of states)
    if (!columns.some((c) => c.name === s.name))
      columns.push({ name: s.name, type: s.type, color: s.color, cards: [] })
  for (const issue of issues) {
    let column = columns.find((c) => c.name === issue.state)
    if (!column) {
      column = { name: issue.state, type: 'unknown', color: '', cards: [] }
      columns.push(column)
    }
    column.cards.push({ ...issue, bot: botOf(issue, bots, desks) })
  }
  for (const c of columns)
    c.cards.sort(
      (a, b) => rank(a.priority) - rank(b.priority) || b.updatedAt.localeCompare(a.updatedAt)
    )
  return columns.filter((c) => c.type !== 'triage' || c.cards.length)
}

/** The Office's desk says which bot and how it is doing; otherwise the bot label says which. */
function botOf(issue: BoardIssue, bots: BotConfig[], desks: Desk[]): BoardCard['bot'] {
  const desk = desks.find((d) => d.ticket === issue.identifier)
  const labels = issue.labels.map((l) => l.toLowerCase())
  const bot =
    bots.find((b) => b.id === desk?.botId) ??
    bots.find((b) => labels.includes(b.label.toLowerCase()))
  if (!bot) return undefined
  return {
    id: bot.id,
    name: bot.name,
    avatar: bot.avatar,
    label: bot.label,
    ...(desk ? { status: desk.status } : {})
  }
}
