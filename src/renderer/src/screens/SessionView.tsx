import { useState } from 'react'
import type { AppConfig, RebaseStart, SessionInfo } from '../../../shared/api'
import { api, errorText } from '../api'
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
  const [updating, setUpdating] = useState(false)
  const [updates, setUpdates] = useState<RebaseStart[] | null>(null)
  const trunks = [
    ...new Set(session.repos.map((r) => cfg.repos.find((x) => x.name === r.name)?.trunk ?? 'main'))
  ]
  const update = async (): Promise<void> => {
    setUpdating(true)
    try {
      setUpdates(await api.rebase.start(session.id))
    } catch (e) {
      setUpdates([{ repo: '—', trunk: '', status: 'error', error: errorText(e) }])
    } finally {
      setUpdating(false)
    }
  }
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
        <button
          disabled={updating}
          title={`Trae lo último de origin y hace rebase de cada repo sobre ${trunks.join('/')}`}
          onClick={update}
        >
          {updating
            ? 'Actualizando…'
            : `⟲ Actualizar con ${trunks.length === 1 ? trunks[0] : 'la base'}`}
        </button>
        {running ? (
          <button onClick={() => api.test.stop(session.id).then(refresh)}>■ Detener</button>
        ) : (
          <button
            className="primary"
            onClick={() =>
              api.test
                .start(session.id)
                .catch(() => {})
                .then(refresh)
            }
          >
            ▶ Probar
          </button>
        )}
        <button
          className="ghost danger"
          title="Borrar sesión"
          onClick={() => del.remove(session.id)}
        >
          🗑
        </button>
      </div>
      {updates && (
        <div className="update-results">
          {updates.map((u) => (
            <span
              key={u.repo}
              className={
                u.status === 'error' || u.status === 'dirty'
                  ? 'error'
                  : u.status === 'conflicts'
                    ? 'warn-text'
                    : 'muted'
              }
            >
              {u.repo}:{' '}
              {u.status === 'done'
                ? `al día con ${u.trunk} (${u.replayed} commit${u.replayed === 1 ? '' : 's'} reaplicado${u.replayed === 1 ? '' : 's'})`
                : u.status === 'clean'
                  ? `ya estaba al día con ${u.trunk}`
                  : u.status === 'dirty'
                    ? 'tiene cambios sin commit: haz commit antes de actualizar'
                    : u.status === 'conflicts'
                      ? 'hay conflictos; resuélvelos en el panel Diff'
                      : u.error}
            </span>
          ))}
          <button className="ghost" onClick={() => setUpdates(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="session-body">
        <div className="pane">
          <div className="pane-bar">
            <span className="label">
              {cfg.agents.find((a) => a.id === session.agent)?.label ?? session.agent}
            </span>
          </div>
          <div className="pane-body">
            <AgentTerminal key={`${session.id}:${session.agent}`} id={session.id} />
          </div>
        </div>
        <div className="right">
          <BrowserPane session={session} testUsers={cfg.testUsers} />
          <DiffPane session={session} />
        </div>
      </div>
      {del.dialog}
    </div>
  )
}
