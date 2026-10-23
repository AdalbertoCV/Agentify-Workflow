import type { AppConfig } from './config'
import { parseReposLine, type Issue } from './linear'
import { run } from './proc'

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

type GhIssue = { number: number; title: string; body: string | null; url: string; state: string }

export async function listGithubIssues(cfg: AppConfig, gh: (args: string[]) => Promise<string>): Promise<Issue[]> {
  const issues: Issue[] = []
  let firstError: unknown
  let answered = 0
  for (const { slug, repo } of await githubRepos(cfg)) {
    try {
      const out = await gh([
        'issue',
        'list',
        '-R',
        slug,
        '--assignee',
        '@me',
        '--state',
        'open',
        '--limit',
        '100',
        '--json',
        'number,title,body,url,state'
      ])
      answered++
      for (const i of JSON.parse(out || '[]') as GhIssue[])
        issues.push({
          identifier: githubTicketId(slug, i.number, repo),
          title: i.title,
          state: i.state === 'OPEN' ? 'Abierto' : i.state,
          description: i.body ?? '',
          url: i.url,
          repo
        })
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
