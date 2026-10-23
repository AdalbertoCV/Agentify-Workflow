import type { AppConfig, RepoConfig, TestUser, TicketProviderId } from '../main/core/config'
import type { DeletePlan, DeleteStep, Session } from '../main/core/sessions'

export type { AppConfig, RepoConfig, DeletePlan, DeleteStep, Session, TestUser, TicketProviderId }

export type DeleteProgress = {
  id: string
  phase: 'confirm' | 'running' | 'paused' | 'failed' | 'deleted'
  plan: DeletePlan
  steps: DeleteStep[]
  error?: string
}

export type TestStatus = 'stopped' | 'starting' | 'running' | 'error'
export type AgentState = 'working' | 'waiting' | 'off'

export type SessionInfo = Session & {
  test: TestStatus
  agentState: AgentState
  url?: string
  deleting?: 'running' | 'failed'
}

export type Issue = {
  identifier: string
  title: string
  state: string
  description: string
  url: string
  /** Config repo the ticket lives in (GitHub Issues). */
  repo?: string
}

export type Check = {
  id: string
  label: string
  ok: boolean
  detail: string
  fix?: { kind: 'command' | 'link' | 'secret'; value: string }
}

export type RepoDiff = { repo: string; patch: string; files: number; unpushed: number }

export type CommitResult = { repo: string; committed: boolean; pushed: boolean; sha?: string; error?: string }

export type OnboardStart = { repoName: string; repoPath: string; workDir: string; terminalId: string }

export type OnboardResult = { repo: RepoConfig; runScript: string; stopScript?: string }

export interface AgentifyApi {
  getConfig(): Promise<AppConfig | null>
  chooseRoot(): Promise<AppConfig | null>
  listSessions(): Promise<SessionInfo[]>
  createSession(input: {
    ticket: string
    title: string
    repos: string[]
    agent?: string
  }): Promise<Session>
  deletion: {
    plan(id: string): Promise<DeleteProgress>
    start(id: string): Promise<void>
    state(id: string): Promise<DeleteProgress | null>
    onProgress(cb: (p: DeleteProgress) => void): () => void
  }
  adoptLoose(): Promise<number>
  setAgent(id: string, agent: string): Promise<void>
  onProgress(cb: (msg: string) => void): () => void
  onSessionsChanged(cb: () => void): () => void

  pty: {
    open(id: string): Promise<void>
    history(id: string): Promise<string>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string, code: number) => void): () => void
  }

  test: {
    start(id: string): Promise<{ url?: string }>
    stop(id: string): Promise<void>
    logs(id: string): Promise<string>
    onLog(cb: (id: string, line: string) => void): () => void
  }

  capture(webContentsId: number, rect?: { x: number; y: number; width: number; height: number }): Promise<void>
  diff(id: string): Promise<RepoDiff[]>
  commit(id: string, message: string): Promise<CommitResult[]>
  openPath(path: string): Promise<void>
  openExternal(url: string): Promise<void>

  tickets: {
    provider(): Promise<TicketProviderId>
    setProvider(provider: TicketProviderId, githubRepos?: string[]): Promise<AppConfig>
    list(): Promise<Issue[]>
    reposFor(issue: Issue): Promise<string[]>
    githubRepos(): Promise<{ slug: string; repo?: string }[]>
  }
  secrets: { set(name: string, value: string): Promise<void> }
  connectors(): Promise<Check[]>
  runFix(command: string): Promise<string>

  repos: {
    startOnboarding(src: { cloneUrl?: string; path?: string }): Promise<OnboardStart>
    readOnboarding(workDir: string): Promise<OnboardResult | null>
    save(repo: RepoConfig): Promise<AppConfig>
    goldenInfo(): Promise<Record<string, string | null>>
    refreshGolden(name: string): Promise<void>
  }
}
