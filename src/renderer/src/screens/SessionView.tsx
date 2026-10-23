import type { AppConfig, SessionInfo } from '../../../shared/api'
import { api } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'
import { BrowserPane } from '../components/BrowserPane'
import { useDelete } from '../components/ConfirmDelete'
import { DiffPane } from '../components/DiffPane'
import { AgentStatus, TestStatusLabel } from '../components/SessionCard'

export function SessionView({
  cfg,
  session,
  onBack,
  refresh
}: {
  cfg: AppConfig
  session: SessionInfo
  onBack: () => void
  refresh: () => void
}): React.JSX.Element {
  const del = useDelete(() => {
    refresh()
    onBack()
  })
  const running = session.test === 'running' || session.test === 'starting'
  const folder = session.repos[0]?.worktree.replace(/[\\/][^\\/]+$/, '')

  return (
    <div className="session">
      <div className="session-bar">
        <button className="ghost" onClick={onBack}>
          ← Tablero
        </button>
        <span className="ticket">{session.ticket}</span>
        <span className="title" style={{ maxWidth: 420 }} title={session.title}>
          {session.title}
        </span>
        <div className="chips">
          {session.repos.map((r) => (
            <span className="chip" key={r.name + r.worktree} title={`${r.branch}\n${r.worktree}`}>
              {r.name}
            </span>
          ))}
        </div>
        <span className="spacer" />
        <AgentStatus s={session} />
        <TestStatusLabel s={session} />
        <select
          value={session.agent}
          title="Agente de esta sesión"
          onChange={(e) => {
            void api.setAgent(session.id, e.target.value).then(refresh)
          }}
        >
          {cfg.agents.map((a) => (
            <option key={a.id} value={a.id}>
              {a.label}
            </option>
          ))}
        </select>
        {folder && (
          <button className="ghost" title="Abrir carpeta" onClick={() => api.openPath(folder)}>
            📁
          </button>
        )}
        {running ? (
          <button onClick={() => api.test.stop(session.id).then(refresh)}>■ Detener</button>
        ) : (
          <button className="primary" onClick={() => api.test.start(session.id).catch(() => {}).then(refresh)}>
            ▶ Probar
          </button>
        )}
        <button className="ghost danger" title="Borrar sesión" onClick={() => del.remove(session.id)}>
          🗑
        </button>
      </div>
      <div className="session-body">
        <div className="pane">
          <div className="pane-bar">
            <span className="label">{cfg.agents.find((a) => a.id === session.agent)?.label ?? session.agent}</span>
          </div>
          <div className="pane-body">
            <AgentTerminal key={`${session.id}:${session.agent}`} id={session.id} />
          </div>
        </div>
        <div className="right">
          <BrowserPane session={session} />
          <DiffPane session={session} />
        </div>
      </div>
      {del.dialog}
    </div>
  )
}
