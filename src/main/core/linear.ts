export type Issue = {
  identifier: string
  title: string
  state: string
  description: string
  url: string
}

const ENDPOINT = 'https://api.linear.app/graphql'

async function gql<T>(key: string, query: string, fetchFn: typeof fetch): Promise<T> {
  const res = await fetchFn(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: key },
    body: JSON.stringify({ query })
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
        nodes { identifier title description url state { name } }
      }
    }
  }`
  type Node = {
    identifier: string
    title: string
    description: string | null
    url: string
    state: { name: string }
  }
  const data = await gql<{ viewer: { assignedIssues: { nodes: Node[] } } }>(key, query, fetchFn)
  return data.viewer.assignedIssues.nodes.map((n) => ({
    identifier: n.identifier,
    title: n.title,
    state: n.state.name,
    description: n.description ?? '',
    url: n.url
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
