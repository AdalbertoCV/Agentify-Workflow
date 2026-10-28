import type { AppConfig, RepoConfig, TestUser, TicketProviderId } from '../main/core/config'
import type { Chunk } from '../main/core/conflicts'
import type { RebaseState, Resolution } from '../main/core/rebase'
import type { TicketStatus } from '../main/core/ticketStatus'
import type { ApiCatalog, ApiRequest, ApiResponse } from '../main/core/apiTesting'
import type { BotConfig } from '../main/core/bots'
import type { Desk } from '../main/core/office'
import type { BoardColumn, IssueDetail } from '../main/core/board'
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
  status: TicketStatus
  /** Unfinished tickets this one waits for. */
  blockedBy?: string[]
}

export type Check = {
  id: string
  label: string
  ok: boolean
  detail: string
  fix?: { kind: 'command' | 'link' | 'secret'; value: string }
}

export type RepoDiff = { repo: string; patch: string; files: number; unpushed: number }

export type CommitResult = {
  repo: string
  committed: boolean
  pushed: boolean
  sha?: string
  forced?: boolean
  error?: string
}

export type { Chunk, Choice } from '../main/core/conflicts'
export type { ConflictFile, RebaseState, Resolution } from '../main/core/rebase'
export type { TicketStatus } from '../main/core/ticketStatus'
export type { ApiCatalog, ApiEndpoint, ApiRequest, ApiResponse } from '../main/core/apiTesting'
export type { BotConfig } from '../main/core/bots'
export type { Desk } from '../main/core/office'
export type { BoardCard, BoardColumn, IssueDetail, IssueLink } from '../main/core/board'
export type RebaseStart = {
  repo: string
  trunk: string
  status: string
  replayed?: number
  error?: string
}

export type OnboardStart = {
  repoName: string
  repoPath: string
  workDir: string
  terminalId: string
}

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
    close(id: string): Promise<void>
    write(id: string, data: string): void
    resize(id: string, cols: number, rows: number): void
    onData(cb: (id: string, data: string) => void): () => void
    onExit(cb: (id: string, code: number) => void): () => void
  }

  test: {
    start(id: string): Promise<{ url?: string }>
    stop(id: string): Promise<void>
    logs(id: string): Promise<string>
    /** Brings up another repo of the folder in the session (and what it needs). */
    startRepo(id: string, repo: string): Promise<{ url?: string }>
    runningRepos(id: string): Promise<string[]>
    onLog(cb: (id: string, line: string) => void): () => void
  }

  rebase: {
    start(id: string): Promise<RebaseStart[]>
    state(id: string): Promise<Record<string, RebaseState>>
    chunks(id: string, repo: string, path: string): Promise<Chunk[]>
    resolve(id: string, repo: string, path: string, how: Resolution): Promise<void>
    continue(id: string, repo: string): Promise<{ status: 'conflicts' | 'done' }>
    abort(id: string, repo: string): Promise<void>
    /** submitted false: typed into an agent that was already open; the user presses Enter. */
    askAgent(id: string, repo: string): Promise<{ submitted: boolean }>
  }

  apiTest: {
    catalog(
      id: string,
      repo: string
    ): Promise<{ catalog: ApiCatalog | null; file: string; error?: string }>
    /** Opens the session's agent to write the catalog; returns its terminal id. */
    fill(id: string, repo: string): Promise<string>
    login(id: string, repo: string, userIndex: number): Promise<{ name: string; value: string }>
    send(id: string, repo: string, req: ApiRequest): Promise<ApiResponse>
    curl(id: string, repo: string, req: ApiRequest): Promise<string>
  }

  office: {
    desks(): Promise<Desk[]>
    refresh(): Promise<Desk[]>
    assign(botId: string, ticket: string): Promise<Desk[]>
    answer(key: string, text: string): Promise<Desk[]>
    iterate(key: string): Promise<Desk[]>
    retry(key: string): Promise<Desk[]>
    dismiss(key: string): Promise<Desk[]>
    onChanged(cb: (desks: Desk[]) => void): () => void
    onFocus(cb: (key: string) => void): () => void
  }
  /** Your Linear tickets by state, with the bot that works each one. */
  board(): Promise<BoardColumn[]>
  /** Any ticket, yours or not, with its parent and sub-tickets. */
  boardIssue(identifier: string): Promise<IssueDetail>
  /** Moves a ticket to a workflow state (by id) of its team. */
  boardMove(identifier: string, stateId: string): Promise<void>
  bots: {
    save(bots: BotConfig[], tokens: Record<string, string>): Promise<AppConfig>
    hasToken(id: string): Promise<boolean>
  }

  capture(
    webContentsId: number,
    rect?: { x: number; y: number; width: number; height: number }
  ): Promise<void>
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
    /** Opens the default agent with the prompt to create a ticket; returns its terminal id. */
    createStart(context: string, githubRepo?: string): Promise<string>
    setPrompt(prompt: string): Promise<AppConfig>
  }
  /** Version and commit the app started from; `newer` is a newer commit already on disk. */
  build(): Promise<{ version: string; commit?: string; newer: string | null }>
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
