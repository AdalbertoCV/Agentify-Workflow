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
