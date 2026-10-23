import type { SessionInfo } from '../../../shared/api'
import { api } from '../api'

export function AgentStatus({ s }: { s: SessionInfo }): React.JSX.Element {
  if (s.agentState === 'waiting')
    return (
      <span className="status" style={{ color: 'var(--warn)' }}>
        <span className="dot warn pulse" /> te está esperando
      </span>
    )
  if (s.agentState === 'working')
    return (
      <span className="status">
        <span className="dot ok pulse" /> trabajando
      </span>
    )
  return (
    <span className="status">
      <span className="dot" /> agente cerrado
    </span>
  )
}

export function TestStatusLabel({ s }: { s: SessionInfo }): React.JSX.Element | null {
  if (s.test === 'running')
    return (
      <span className="status">
        <span className="dot ok" /> app corriendo
      </span>
    )
  if (s.test === 'starting')
    return (
      <span className="status">
        <span className="dot warn pulse" /> levantando…
      </span>
    )
  if (s.test === 'error')
    return (
      <span className="status" style={{ color: 'var(--bad)' }}>
        <span className="dot bad" /> Probar falló
      </span>
    )
  return null
}

export function SessionCard({
  s,
  onOpen,
  onDelete
}: {
  s: SessionInfo
  onOpen: () => void
  onDelete: () => void
}): React.JSX.Element {
  const running = s.test === 'running' || s.test === 'starting'
  if (s.deleting)
    return (
      <div className="card deleting" onClick={onDelete} title={s.deleting === 'failed' ? 'Abre para ver el error y reintentar' : 'Abre para ver el progreso'}>
        <div className="card-top">
          <span className="ticket">{s.ticket}</span>
        </div>
        <div className="title">{s.title || '—'}</div>
        {s.deleting === 'running' ? (
          <span className="status">
            <span className="dot bad pulse" /> Borrando…
          </span>
        ) : (
          <span className="status" style={{ color: 'var(--bad)' }}>
            <span className="dot bad" /> Borrado incompleto
          </span>
        )}
      </div>
    )
  return (
    <div className={`card ${s.agentState === 'waiting' ? 'waiting' : ''}`} onClick={onOpen}>
      <div className="card-top">
        <span className="ticket">{s.ticket}</span>
        {s.imported && <span className="chip tag">importada</span>}
        <span className="spacer" />
        <AgentStatus s={s} />
      </div>
      <div className="title" title={s.title}>
        {s.title || '—'}
      </div>
      <div className="chips">
        {s.repos.map((r) => (
          <span className="chip" key={r.name + r.worktree} title={r.branch}>
            {r.name}
          </span>
        ))}
      </div>
      <TestStatusLabel s={s} />
      <div className="card-actions" onClick={(e) => e.stopPropagation()}>
        <button className="primary" onClick={onOpen}>
          Abrir
        </button>
        {running ? (
          <button onClick={() => api.test.stop(s.id)}>■ Detener</button>
        ) : (
          <button
            onClick={() => {
              void api.test.start(s.id).catch(() => {})
              onOpen()
            }}
          >
            ▶ Probar
          </button>
        )}
        <span className="spacer" />
        <button className="ghost danger" title="Borrar sesión" onClick={onDelete}>
          🗑
        </button>
      </div>
    </div>
  )
}
