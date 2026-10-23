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
    write: (id, data) => ipcRenderer.send('pty:write', id, data),
    resize: (id, cols, rows) => ipcRenderer.send('pty:resize', id, cols, rows),
    onData: (cb) => listen('pty:data', cb),
    onExit: (cb) => listen('pty:exit', cb)
  },

  test: {
    start: (id) => invoke('test:start', id),
    stop: (id) => invoke('test:stop', id),
    logs: (id) => invoke('test:logs', id),
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

  capture: (wcId, rect) => invoke('capture', wcId, rect),
  diff: (id) => invoke('diff', id),
  commit: (id, message) => invoke('commit', id, message),
  openPath: (p) => invoke('open:path', p),
  openExternal: (u) => invoke('open:external', u),

  tickets: {
    provider: () => invoke('tickets:provider'),
    setProvider: (p, repos) => invoke('tickets:set-provider', p, repos),
    list: () => invoke('tickets:list'),
    reposFor: (i) => invoke('tickets:repos-for', i),
    githubRepos: () => invoke('tickets:github-repos')
  },
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
