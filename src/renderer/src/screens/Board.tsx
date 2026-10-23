import { useEffect, useRef, useState } from 'react'
import type { AppConfig, SessionInfo } from '../../../shared/api'
import { api, errorText, useInterval } from '../api'
import { useDelete } from '../components/ConfirmDelete'
import { SessionCard } from '../components/SessionCard'
import { NewSessionDialog } from './NewSessionDialog'

export function Board({
  cfg,
  sessions,
  refresh,
  onOpen,
  onConnectLinear
}: {
  cfg: AppConfig
  sessions: SessionInfo[]
  refresh: () => void
  onOpen: (id: string) => void
  onConnectLinear: () => void
}): React.JSX.Element {
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')
  const adopted = useRef(false)
  const del = useDelete(refresh)

  useEffect(() => {
    if (adopted.current) return
    adopted.current = true
    void api
      .adoptLoose()
      .then((n) => {
        if (n) setNotice(`Encontré ${n} worktree${n > 1 ? 's' : ''} suelto${n > 1 ? 's' : ''} y los agregué como sesiones importadas.`)
        refresh()
      })
      .catch((e) => setNotice(errorText(e)))
  }, [refresh])

  useInterval(refresh, 2000)

  return (
    <div className="page">
      <div className="page-head">
        <h1>Sesiones</h1>
        <span className="muted">{sessions.length}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => setCreating(true)}>
          + Nueva sesión
        </button>
      </div>
      {notice && (
        <div className="row" style={{ marginBottom: 14 }}>
          <span className="muted">{notice}</span>
          <button className="ghost" onClick={() => setNotice('')}>
            ✕
          </button>
        </div>
      )}
      {sessions.length === 0 ? (
        <div className="empty">Aún no tienes sesiones. Crea la primera con + Nueva sesión.</div>
      ) : (
        <div className="grid">
          {sessions.map((s) => (
            <SessionCard key={s.id} s={s} onOpen={() => onOpen(s.id)} onDelete={() => del.remove(s.id)} />
          ))}
        </div>
      )}
      {creating && (
        <NewSessionDialog
          cfg={cfg}
          onClose={() => setCreating(false)}
          onConnectLinear={() => {
            setCreating(false)
            onConnectLinear()
          }}
          onCreated={(s) => {
            setCreating(false)
            refresh()
            onOpen(s.id)
          }}
        />
      )}
      {del.dialog}
    </div>
  )
}
