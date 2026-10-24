import type { AppConfig } from './config'
import { parseReposLine, type Issue } from './linear'
import { run } from './proc'
import { githubStatus } from './ticketStatus'

/** "owner/repo" of a GitHub remote URL (https or ssh); null for anything else. */
export function githubSlug(remoteUrl: string): string | null {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remoteUrl.trim())
  return m ? `${m[1]}/${m[2]}` : null
}

/** Repos to read issues from: the config repos hosted on GitHub, then the extra ones. */
export async function githubRepos(cfg: AppConfig): Promise<{ slug: string; repo?: string }[]> {
  const out: { slug: string; repo?: string }[] = []
  for (const r of cfg.repos) {
    try {
      const { stdout } = await run('git', ['remote', 'get-url', 'origin'], { cwd: r.path })
      const slug = githubSlug(stdout)
      if (slug) out.push({ slug, repo: r.name })
    } catch {
      // no checkout or no origin: nothing to read from
    }
  }
  for (const slug of cfg.tickets?.githubRepos ?? [])
    if (!out.some((x) => x.slug.toLowerCase() === slug.toLowerCase())) out.push({ slug })
  return out
}

/** "api#123" for a config repo; extra repos keep their owner ("org/issues#45") so ids never collide. */
export function githubTicketId(slug: string, number: number, repoName?: string): string {
  return `${repoName ?? slug}#${number}`
}

type GhIssue = {
  number: number
  title: string
  body: string | null
  url: string
  labels: { nodes: { name: string }[] }
  blockedBy: { nodes: { number: number; state: string; repository: { nameWithOwner: string } }[] }
}

// GraphQL, not `gh issue list`: only it tells which issues block another ("blocked by").
const ISSUES_QUERY = `query($owner: String!, $name: String!, $login: String!) {
  repository(owner: $owner, name: $name) {
    issues(first: 100, states: OPEN, filterBy: { assignee: $login }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes {
        number title body url
        labels(first: 20) { nodes { name } }
        blockedBy(first: 10) { nodes { number state repository { nameWithOwner } } }
      }
    }
  }
}`

const STATE_LABEL = { ready: 'Abierto', 'in-progress': 'En progreso', 'in-review': 'En revisión', blocked: 'Bloqueado' }

export async function listGithubIssues(cfg: AppConfig, gh: (args: string[]) => Promise<string>): Promise<Issue[]> {
  const issues: Issue[] = []
  let firstError: unknown
  let answered = 0
  let login: string | undefined
  for (const { slug, repo } of await githubRepos(cfg)) {
    try {
      login ??= (await gh(['api', 'user', '-q', '.login'])).trim()
      const [owner, name] = slug.split('/')
      const out = await gh([
        'api',
        'graphql',
        '-F',
        `owner=${owner}`,
        '-F',
        `name=${name}`,
        '-F',
        `login=${login}`,
        '-f',
        // One line: on Windows a .cmd wrapper would cut the argument at a newline.
        `query=${ISSUES_QUERY.replace(/\s+/g, ' ')}`
      ])
      answered++
      const nodes = (JSON.parse(out) as { data: { repository: { issues: { nodes: GhIssue[] } } } }).data.repository.issues
        .nodes
      for (const i of nodes) {
        const info = githubStatus(
          i.labels.nodes.map((l) => l.name),
          i.blockedBy.nodes.map((b) => ({ ref: `${b.repository.nameWithOwner}#${b.number}`, open: b.state === 'OPEN' }))
        )
        issues.push({
          identifier: githubTicketId(slug, i.number, repo),
          title: i.title,
          state: STATE_LABEL[info.status],
          description: i.body ?? '',
          url: i.url,
          repo,
          ...info
        })
      }
    } catch (e) {
      firstError ??= e
    }
  }
  if (!answered && firstError) throw firstError
  return issues
}

export function githubReposFor(issue: Issue, known: string[]): string[] {
  const named = parseReposLine(issue.description, known)
  if (named.length) return named
  return issue.repo && known.includes(issue.repo) ? [issue.repo] : []
}
