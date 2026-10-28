import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { AgentifyApi } from '../shared/api'

function listen<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const handler = (_e: IpcRendererEvent, ...args: T): void => cb(...args)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const invoke = ipcRenderer.invoke.bind(ipcRenderer)

const api: AgentifyApi = {
  getConfig: () => invoke('config:get'),
  chooseRoot: () => invoke('config:choose-root'),
  listSessions: () => invoke('sessions:list'),
  createSession: (input) => invoke('sessions:create', input),
  deletion: {
    plan: (id) => invoke('sessions:delete-plan', id),
    start: (id) => invoke('sessions:delete-start', id),
    state: (id) => invoke('sessions:delete-state', id),
    onProgress: (cb) => listen('sessions:delete-progress', cb)
  },
  adoptLoose: () => invoke('sessions:adopt'),
  setAgent: (id, agent) => invoke('sessions:set-agent', id, agent),
  onProgress: (cb) => listen('sessions:progress', cb),
  onSessionsChanged: (cb) => listen('sessions:changed', cb),

  pty: {
    open: (id) => invoke('pty:open', id),
    history: (id) => invoke('pty:history', id),
    close: (id) => invoke('pty:close', id),
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: (cb) => listen('pty:data', cb),
    onExit: (cb) => listen('pty:exit', cb)
  },

  test: {
    start: (id) => invoke('test:start', id),
    stop: (id) => invoke('test:stop', id),
    logs: (id) => invoke('test:logs', id),
    startRepo: (id, repo) => invoke('test:start-repo', id, repo),
    runningRepos: (id) => invoke('test:running-repos', id),
    onLog: (cb) => listen('test:log', cb)
  },

  rebase: {
    start: (id) => invoke('rebase:start', id),
    state: (id) => invoke('rebase:state', id),
    chunks: (id, repo, path) => invoke('rebase:chunks', id, repo, path),
    resolve: (id, repo, path, how) => invoke('rebase:resolve', id, repo, path, how),
    continue: (id, repo) => invoke('rebase:continue', id, repo),
    abort: (id, repo) => invoke('rebase:abort', id, repo),
    askAgent: (id, repo) => invoke('rebase:ask-agent', id, repo)
  },

  apiTest: {
    catalog: (id, repo) => invoke('api:catalog', id, repo),
    fill: (id, repo) => invoke('api:fill', id, repo),
    login: (id, repo, i) => invoke('api:login', id, repo, i),
    send: (id, repo, req) => invoke('api:send', id, repo, req),
    curl: (id, repo, req) => invoke('api:curl', id, repo, req)
  },

  office: {
    desks: () => invoke('office:desks'),
    refresh: () => invoke('office:refresh'),
    assign: (botId, ticket) => invoke('office:assign', botId, ticket),
    answer: (key, text) => invoke('office:answer', key, text),
    iterate: (key) => invoke('office:iterate', key),
    retry: (key) => invoke('office:retry', key),
    dismiss: (key) => invoke('office:dismiss', key),
    onChanged: (cb) => listen('office:changed', cb),
    onFocus: (cb) => listen('office:focus', cb)
  },
  board: () => invoke('board:get'),
  boardIssue: (identifier) => invoke('board:issue', identifier),
  boardMove: (identifier, stateId) => invoke('board:move', identifier, stateId),
  bots: {
    save: (bots, tokens) => invoke('bots:save', bots, tokens),
    hasToken: (id) => invoke('bots:has-token', id)
  },

  capture: (wcId, rect) => invoke('capture', wcId, rect),
  diff: (id) => invoke('diff', id),
  commit: (id, message) => invoke('commit', id, message),
  openPath: (p) => invoke('open:path', p),
  openExternal: (u) => invoke('open:external', u),
  artifactsUrl: () => invoke('artifacts:url'),

  tickets: {
    provider: () => invoke('tickets:provider'),
    setProvider: (p, repos) => invoke('tickets:set-provider', p, repos),
    list: () => invoke('tickets:list'),
    reposFor: (i) => invoke('tickets:repos-for', i),
    githubRepos: () => invoke('tickets:github-repos'),
    createStart: (context, repo) => invoke('tickets:create-start', context, repo),
    setPrompt: (prompt) => invoke('tickets:set-prompt', prompt)
  },
  build: () => invoke('app:build'),
  secrets: { set: (name, value) => invoke('secrets:set', name, value) },
  connectors: () => invoke('connectors'),
  runFix: (command) => invoke('connectors:run-fix', command),

  repos: {
    startOnboarding: (src) => invoke('repos:onboard-start', src),
    readOnboarding: (workDir) => invoke('repos:onboard-read', workDir),
    save: (repo) => invoke('repos:save', repo),
    goldenInfo: () => invoke('repos:golden-info'),
    refreshGolden: (name) => invoke('repos:golden-refresh', name)
  }
}

contextBridge.exposeInMainWorld('agentify', api)
