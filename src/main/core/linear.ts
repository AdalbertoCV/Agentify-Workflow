import type { BoardIssue, IssueDetail, IssueLink, TeamStates, WorkflowState } from './board'
import { linearStatus, type TicketStatus } from './ticketStatus'

export type Issue = {
  identifier: string
  title: string
  state: string
  description: string
  url: string
  /** Config repo the ticket lives in (GitHub Issues). */
  repo?: string
  status: TicketStatus
  /** Unfinished tickets this one waits for. */
  blockedBy?: string[]
}

const ENDPOINT = 'https://api.linear.app/graphql'

async function gql<T>(
  key: string,
  query: string,
  fetchFn: typeof fetch,
  variables?: Record<string, unknown>
): Promise<T> {
  // AGENTIFY_LINEAR_URL points the app at a stand-in Linear in the end-to-end tests.
  const res = await fetchFn(process.env.AGENTIFY_LINEAR_URL ?? ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query, variables })
  })
  if (!res.ok) throw new Error(`Linear respondió ${res.status}`)
  const json = (await res.json()) as { data?: T; errors?: { message: string }[] }
  if (json.errors?.length) throw new Error(`Linear: ${json.errors[0].message}`)
  return json.data as T
}

export async function linearViewer(key: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const data = await gql<{ viewer: { name: string } }>(key, '{ viewer { name } }', fetchFn)
  return data.viewer.name
}

export async function listMyIssues(key: string, fetchFn: typeof fetch = fetch): Promise<Issue[]> {
  const query = `{
    viewer {
      assignedIssues(
        first: 100
        orderBy: updatedAt
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) {
        nodes {
          identifier title description url state { name type }
          inverseRelations(first: 10) { nodes { type issue { identifier state { type } } } }
        }
      }
    }
  }`
  type Node = {
    identifier: string
    title: string
    description: string | null
    url: string
    state: { name: string; type: string }
    inverseRelations: {
      nodes: { type: string; issue: { identifier: string; state: { type: string } } }[]
    }
  }
  const data = await gql<{ viewer: { assignedIssues: { nodes: Node[] } } }>(key, query, fetchFn)
  return data.viewer.assignedIssues.nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    state: n.state.name,
    description: n.description ?? '',
    url: n.url,
    ...linearStatus(n.state, n.inverseRelations.nodes)
  }))
}

/** Your tickets for the board: open ones plus the ones done in the last 14 days, and your teams' workflows. */
export async function boardIssues(
  key: string,
  fetchFn: typeof fetch = fetch
): Promise<{ issues: BoardIssue[]; teams: TeamStates[] }> {
  // Only open tickets count their children: done ones never show the count, and Linear charges
  // every nested list against the 10000 complexity limit.
  const query = `{
    viewer {
      teams(first: 20) { nodes { key states(first: 30) { nodes { id name type position color } } } }
      open: assignedIssues(
        first: 100
        orderBy: updatedAt
        filter: { state: { type: { nin: ["completed", "canceled"] } } }
      ) { nodes { ...card children(first: ${KIDS}) { nodes { state { type } } } } }
      done: assignedIssues(
        first: 100
        orderBy: updatedAt
        filter: { state: { type: { eq: "completed" } }, completedAt: { gt: "-P14D" } }
      ) { nodes { ...card } }
    }
  }
  fragment card on Issue {
    ${CARD_FIELDS}
  }`
  const data = await gql<{
    viewer: {
      teams: { nodes: { key: string; states: { nodes: WorkflowState[] } }[] }
      open: { nodes: CardNode[] }
      done: { nodes: CardNode[] }
    }
  }>(key, query, fetchFn)
  // An epic that fills the first page of children is counted again on its own, in full.
  const big = data.viewer.open.nodes.filter((n) => n.children?.nodes.length === KIDS).slice(0, 10)
  if (big.length) {
    const aliases = big.map(
      (n, i) =>
        `e${i}: issue(id: "${n.identifier}") { identifier children(first: 250) { nodes { state { type } } } }`
    )
    const more = await gql<Record<string, { identifier: string; children: CardNode['children'] }>>(
      key,
      `{ ${aliases.join(' ')} }`,
      fetchFn
    )
    for (const e of Object.values(more)) {
      const n = big.find((b) => b.identifier === e.identifier)
      if (n) n.children = e.children
    }
  }
  return {
    teams: data.viewer.teams.nodes.map((t) => ({ key: t.key, states: t.states.nodes })),
    // Two lists so a busy fortnight of done tickets never pushes open ones out of the first 100.
    issues: [...data.viewer.open.nodes, ...data.viewer.done.nodes].map((n) => {
      const kids = n.children?.nodes ?? []
      return {
        ...toBoardIssue(n),
        ...(kids.length
          ? { children: { done: kids.filter((k) => isDone(k.state)).length, total: kids.length } }
          : {})
      }
    })
  }
}

const KIDS = 25

const CARD_FIELDS = `identifier title description url priority updatedAt
    team { key }
    labels(first: 10) { nodes { name } }
    state { name type }
    parent { identifier }
    inverseRelations(first: 10) { nodes { type issue { identifier state { type } } } }`

type StateRef = { name: string; type: string }
type CardNode = {
  identifier: string
  title: string
  description: string | null
  url: string
  priority: number
  updatedAt: string
  team: { key: string }
  labels: { nodes: { name: string }[] }
  state: StateRef
  parent?: { identifier: string } | null
  children?: { nodes: { state: { type: string } }[] }
  inverseRelations: {
    nodes: { type: string; issue: { identifier: string; state: { type: string } } }[]
  }
}
type LinkNode = { identifier: string; title: string; state: StateRef }

const isDone = (state: { type: string }): boolean =>
  state.type === 'completed' || state.type === 'canceled'

function toBoardIssue(n: CardNode): BoardIssue {
  return {
    identifier: n.identifier,
    title: n.title,
    description: n.description ?? '',
    url: n.url,
    state: n.state.name,
    ...linearStatus(n.state, n.inverseRelations.nodes),
    priority: n.priority,
    labels: n.labels.nodes.map((l) => l.name),
    team: n.team.key,
    updatedAt: n.updatedAt,
    ...(n.parent ? { parent: n.parent.identifier } : {})
  }
}

function toLink(n: LinkNode): IssueLink {
  return {
    identifier: n.identifier,
    title: n.title,
    state: n.state.name,
    status: linearStatus(n.state, []).status,
    done: isDone(n.state)
  }
}

/** Open sub-tickets before done ones, each group in ticket order (T-2 before T-12). */
function byOpenThenNumber(a: IssueLink, b: IssueLink): number {
  const n = (l: IssueLink): number => Number(l.identifier.split('-').pop())
  return Number(a.done) - Number(b.done) || n(a) - n(b)
}

/** Any ticket by its identifier, assigned to you or not, with its parent and its sub-tickets. */
export async function issueDetail(
  key: string,
  identifier: string,
  fetchFn: typeof fetch = fetch
): Promise<Omit<IssueDetail, 'bot'>> {
  const query = `query($id: String!) {
    issue(id: $id) {
      ${CARD_FIELDS}
      assignee { name }
      parent { identifier title state { name type } }
      children(first: 250) { nodes { identifier title state { name type } } }
    }
  }`
  const { issue } = await gql<{
    issue: CardNode & {
      assignee: { name: string } | null
      parent: LinkNode | null
      children: { nodes: LinkNode[] }
    }
  }>(key, query, fetchFn, { id: identifier })
  return {
    ...toBoardIssue(issue),
    ...(issue.assignee ? { assignee: issue.assignee.name } : {}),
    parent: issue.parent ? toLink(issue.parent) : undefined,
    children: issue.children.nodes.map(toLink).sort(byOpenThenNumber)
  }
}

/** Moves the ticket to a workflow state of its team (a card dropped on another column). */
export async function setIssueState(
  key: string,
  identifier: string,
  stateId: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const { issue } = await gql<{ issue: { id: string } }>(
    key,
    'query($id: String!) { issue(id: $id) { id } }',
    fetchFn,
    { id: identifier }
  )
  await gql(
    key,
    'mutation($id: String!, $stateId: String!) { issueUpdate(id: $id, input: { stateId: $stateId }) { success } }',
    fetchFn,
    { id: issue.id, stateId }
  )
}

/** Repos named on the ticket's `**Repos:**` line, limited to the ones the config knows. */
export function parseReposLine(description: string, known: string[]): string[] {
  const line = description.split(/\r?\n/).find((l) => /\*\*Repos:?\*\*/i.test(l))
  if (!line) return []
  const rest = line.replace(/^.*\*\*Repos:?\*\*:?/i, '')
  const out: string[] = []
  for (const token of rest.split(/[→,+\s`]+/)) {
    const name = token.trim()
    if (known.includes(name) && !out.includes(name)) out.push(name)
  }
  return out
}

/** An issue a bot works: its comments (the bot reports there) and the PRs attached to it. */
export type LabelledIssue = {
  id: string
  identifier: string
  title: string
  url: string
  state: string
  comments: { body: string; createdAt: string }[]
  prUrls: string[]
}

/** Open issues carrying `label`, across the workspace: the ones a bot was given or took itself. */
export async function labelledIssues(
  key: string,
  label: string,
  fetchFn: typeof fetch = fetch
): Promise<LabelledIssue[]> {
  // Bounded lists: Linear rejects queries over 10000 complexity.
  const query = `query($label: String!) {
    issues(first: 50, filter: { labels: { name: { eqIgnoreCase: $label } }, state: { type: { nin: ["completed", "canceled"] } } }) {
      nodes {
        id identifier title url
        state { name }
        comments(first: 30) { nodes { body createdAt } }
        attachments(first: 10) { nodes { url } }
      }
    }
  }`
  type Node = {
    id: string
    identifier: string
    title: string
    url: string
    state: { name: string }
    comments: { nodes: { body: string; createdAt: string }[] }
    attachments: { nodes: { url: string }[] }
  }
  const data = await gql<{ issues: { nodes: Node[] } }>(key, query, fetchFn, { label })
  return data.issues.nodes.map((n) => ({
    id: n.id,
    identifier: n.identifier,
    title: n.title,
    url: n.url,
    state: n.state.name,
    comments: n.comments.nodes,
    prUrls: n.attachments.nodes
      .map((a) => a.url)
      .filter((u) => /github\.com\/[^/]+\/[^/]+\/pull\/\d+/.test(u))
  }))
}

/** Adds an existing workspace label to the issue (assigning it to the bot that watches that label). */
export async function addIssueLabel(
  key: string,
  identifier: string,
  label: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const found = await gql<{ issueLabels: { nodes: { id: string }[] }; issue: { id: string } }>(
    key,
    `query($label: String!, $issue: String!) {
      issueLabels(first: 1, filter: { name: { eqIgnoreCase: $label } }) { nodes { id } }
      issue(id: $issue) { id }
    }`,
    fetchFn,
    { label, issue: identifier }
  )
  const labelId = found.issueLabels.nodes[0]?.id
  if (!labelId) throw new Error(`No existe la etiqueta "${label}" en Linear; créala primero`)
  await gql(
    key,
    'mutation($id: String!, $labelId: String!) { issueAddLabel(id: $id, labelId: $labelId) { success } }',
    fetchFn,
    {
      id: found.issue.id,
      labelId
    }
  )
}

/** Posts a comment on the issue as the owner of the key. */
export async function commentOnIssue(
  key: string,
  identifier: string,
  body: string,
  fetchFn: typeof fetch = fetch
): Promise<void> {
  const { issue } = await gql<{ issue: { id: string } }>(
    key,
    'query($id: String!) { issue(id: $id) { id } }',
    fetchFn,
    {
      id: identifier
    }
  )
  await gql(
    key,
    'mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }',
    fetchFn,
    {
      input: { issueId: issue.id, body }
    }
  )
}
