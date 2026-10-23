import { ticketProvider, type AppConfig, type TicketProviderId } from './config'
import type { Check } from './connectors'
import { githubRepos, githubReposFor, listGithubIssues } from './github'
import { linearViewer, listMyIssues, parseReposLine, type Issue } from './linear'

export type TicketDeps = {
  secret: (name: string) => string | null
  fetchFn: typeof fetch
  gh: (args: string[]) => Promise<string>
}

/** Where the tickets of a project come from. Manual has nothing to list or check. */
export type TicketProvider = {
  id: TicketProviderId
  check(): Promise<Check | null>
  list(): Promise<Issue[]>
  reposFor(issue: Issue): string[]
}

function firstLine(e: unknown): string {
  const m = (e as { stderr?: string }).stderr || (e as Error).message || String(e)
  return m.trim().split(/\r?\n/)[0] ?? ''
}

export function providerFor(cfg: AppConfig, deps: TicketDeps): TicketProvider {
  const known = cfg.repos.map((r) => r.name)
  const id = ticketProvider(cfg, Boolean(deps.secret('linear')))

  if (id === 'linear')
    return {
      id,
      reposFor: (i) => parseReposLine(i.description, known),
      async list() {
        const key = deps.secret('linear')
        if (!key) throw new Error('Linear no está conectado → Conectores')
        return listMyIssues(key, deps.fetchFn)
      },
      async check() {
        const key = deps.secret('linear')
        const fix = { kind: 'secret' as const, value: 'linear' }
        if (!key) return { id: 'linear', label: 'Linear', ok: false, detail: 'Sin llave de API', fix }
        try {
          return { id: 'linear', label: 'Linear', ok: true, detail: `Conectado como ${await linearViewer(key, deps.fetchFn)}` }
        } catch (e) {
          return { id: 'linear', label: 'Linear', ok: false, detail: firstLine(e), fix }
        }
      }
    }

  if (id === 'github')
    return {
      id,
      reposFor: (i) => githubReposFor(i, known),
      list: () => listGithubIssues(cfg, deps.gh),
      async check() {
        const base = { id: 'github-issues', label: 'GitHub Issues' }
        const repos = await githubRepos(cfg)
        if (!repos.length)
          return { ...base, ok: false, detail: 'Ningún repo del proyecto está en GitHub; agrega uno en Conectores' }
        try {
          await deps.gh(['auth', 'status'])
        } catch (e) {
          return { ...base, ok: false, detail: firstLine(e), fix: { kind: 'command', value: 'gh auth login' } }
        }
        return { ...base, ok: true, detail: `Issues asignados a ti en ${repos.map((r) => r.slug).join(', ')}` }
      }
    }

  return { id, reposFor: () => [], list: async () => [], check: async () => null }
}
