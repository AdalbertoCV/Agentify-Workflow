import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from './config'
import { linearViewer } from './linear'

export type Check = {
  id: string
  label: string
  ok: boolean
  detail: string
  fix?: { kind: 'command' | 'link' | 'secret'; value: string }
}

type Out = { stdout: string; stderr: string }

export type ConnectorDeps = {
  run: (cmd: string, args: string[], env?: Record<string, string>) => Promise<Out>
  shell: (line: string) => Promise<Out>
  secret: (name: string) => string | null
  fetchFn: typeof fetch
}

const AGENT_INSTALL: Record<string, string> = {
  claude: 'npm install -g @anthropic-ai/claude-code',
  codex: 'npm install -g @openai/codex',
  gemini: 'npm install -g @google/gemini-cli',
  opencode: 'npm install -g opencode-ai'
}

function firstLine(s: string): string {
  return s.trim().split(/\r?\n/)[0] ?? ''
}

function errText(e: unknown): string {
  const m = (e as { stderr?: string; message?: string }).stderr || (e as Error).message || String(e)
  return firstLine(m)
}

async function tool(
  id: string,
  label: string,
  attempt: () => Promise<string>,
  fix: Check['fix']
): Promise<Check> {
  try {
    return { id, label, ok: true, detail: await attempt() }
  } catch (e) {
    return { id, label, ok: false, detail: errText(e) || 'No encontrado', fix }
  }
}

export async function checkConnectors(cfg: AppConfig, deps: ConnectorDeps): Promise<Check[]> {
  const checks: Promise<Check>[] = [
    tool('git', 'Git', async () => firstLine((await deps.run('git', ['--version'])).stdout), {
      kind: 'link',
      value: 'https://git-scm.com/download/win'
    }),
    tool(
      'gh',
      'GitHub CLI',
      async () => {
        const { stdout, stderr } = await deps.run('gh', ['auth', 'status'])
        const text = stdout + stderr
        const lines = text.split(/\r?\n/)
        const i = lines.findIndex((l) => /Active account: true/.test(l))
        const account = i > 0 ? /account (\S+)/.exec(lines[i - 1])?.[1] : /account (\S+)/.exec(text)?.[1]
        return account ? `Cuenta activa: ${account}` : firstLine(text)
      },
      { kind: 'command', value: 'gh auth login' }
    ),
    tool(
      'docker',
      'Docker',
      async () => `Docker ${firstLine((await deps.run('docker', ['info', '--format', '{{.ServerVersion}}'])).stdout)}`,
      { kind: 'link', value: 'https://www.docker.com/products/docker-desktop/' }
    ),
    tool('postgres', 'PostgreSQL', async () => firstLine((await deps.run('psql', ['--version'])).stdout), {
      kind: 'link',
      value: 'https://www.postgresql.org/download/windows/'
    })
  ]

  for (const repo of cfg.repos.filter((r) => r.db)) {
    checks.push(
      tool(
        `db:${repo.name}`,
        `Base de ${repo.name}`,
        async () => {
          const envFile = join(repo.path, repo.db!.envFile)
          if (!existsSync(envFile)) throw new Error(`No existe ${envFile}`)
          const { dbSource } = await import('./sessions')
          const { conn, source } = dbSource(repo)
          await deps.run(
            'psql',
            ['-h', conn.host, '-p', conn.port, '-U', conn.user, '-d', source, '-tAc', 'select 1'],
            { PGPASSWORD: conn.password }
          )
          return `Conecta a ${source}`
        },
        { kind: 'link', value: 'https://www.postgresql.org/docs/current/app-psql.html' }
      )
    )
  }

  for (const agent of cfg.agents) {
    checks.push(
      tool(
        `agent:${agent.id}`,
        agent.label,
        async () => firstLine((await deps.run(agent.command, ['--version'])).stdout),
        AGENT_INSTALL[agent.id] ? { kind: 'command', value: AGENT_INSTALL[agent.id] } : undefined
      )
    )
  }

  checks.push(
    (async (): Promise<Check> => {
      const key = deps.secret('linear')
      const fix = { kind: 'secret' as const, value: 'linear' }
      if (!key) return { id: 'linear', label: 'Linear', ok: false, detail: 'Sin llave de API', fix }
      try {
        return { id: 'linear', label: 'Linear', ok: true, detail: `Conectado como ${await linearViewer(key, deps.fetchFn)}` }
      } catch (e) {
        return { id: 'linear', label: 'Linear', ok: false, detail: errText(e), fix }
      }
    })()
  )

  ;(cfg.extraChecks ?? []).forEach((x, i) => {
    checks.push(
      (async (): Promise<Check> => {
        const fix = x.fix ? { kind: 'command' as const, value: x.fix } : undefined
        try {
          const { stdout, stderr } = await deps.shell(x.command)
          const ok = !x.expect || (stdout + stderr).includes(x.expect)
          return { id: `extra:${i}`, label: x.label, ok, detail: ok ? 'OK' : `No encontré "${x.expect}"`, fix: ok ? undefined : fix }
        } catch (e) {
          return { id: `extra:${i}`, label: x.label, ok: false, detail: errText(e), fix }
        }
      })()
    )
  })

  return Promise.all(checks)
}
