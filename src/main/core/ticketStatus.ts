/**
 * Where a ticket stands, the same for every provider. Only `ready` tickets start a session:
 * a blocked one waits for another ticket, and one in progress or in review is already being worked.
 */
export type TicketStatus = 'ready' | 'in-progress' | 'in-review' | 'blocked'
export type StatusInfo = { status: TicketStatus; blockedBy?: string[] }

const DONE = ['completed', 'canceled']

type LinearRelation = { type: string; issue: { identifier: string; state: { type: string } } }

/** `inverse` are the relations pointing at this issue: type "blocks" means `issue` blocks it. */
export function linearStatus(state: { name: string; type: string }, inverse: LinearRelation[]): StatusInfo {
  const blockedBy = inverse
    .filter((r) => r.type === 'blocks' && !DONE.includes(r.issue.state.type))
    .map((r) => r.issue.identifier)
  if (blockedBy.length) return { status: 'blocked', blockedBy }
  if (/block/i.test(state.name)) return { status: 'blocked' }
  if (state.type === 'started') return { status: /review/i.test(state.name) ? 'in-review' : 'in-progress' }
  return { status: 'ready' }
}

/** GitHub has no workflow states: open "blocked by" issues and labels say it. */
export function githubStatus(labels: string[], blockers: { ref: string; open: boolean }[]): StatusInfo {
  const blockedBy = blockers.filter((b) => b.open).map((b) => b.ref)
  if (blockedBy.length) return { status: 'blocked', blockedBy }
  if (labels.some((l) => /block/i.test(l))) return { status: 'blocked' }
  if (labels.some((l) => /review/i.test(l))) return { status: 'in-review' }
  if (labels.some((l) => /in.?progress|doing|wip/i.test(l))) return { status: 'in-progress' }
  return { status: 'ready' }
}

export function selectable(status: TicketStatus): boolean {
  return status === 'ready'
}
