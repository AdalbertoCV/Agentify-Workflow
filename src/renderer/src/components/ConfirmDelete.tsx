import { useState } from 'react'
import type { DeleteResult } from '../../../shared/api'
import { api, errorText } from '../api'

type Confirm = Extract<DeleteResult, { status: 'needs-confirm' }>
type Pending = { id: string; risks: Confirm['risks']; processes: Confirm['processes'] }

/**
 * One click deletes. This only appears when something would be lost; otherwise
 * `useDelete` finishes without showing anything.
 */
export function useDelete(onDeleted: () => void): {
  remove: (id: string) => Promise<void>
  dialog: React.JSX.Element | null
} {
  const [pending, setPending] = useState<Pending | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = async (id: string, force: boolean): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      const r = await api.deleteSession(id, force)
      if (r.status === 'needs-confirm') setPending({ id, risks: r.risks, processes: r.processes })
      else {
        setPending(null)
        onDeleted()
      }
    } catch (e) {
      setError(errorText(e))
      if (!pending) setPending({ id, risks: [], processes: [] })
    } finally {
      setBusy(false)
    }
  }

  const dialog = pending ? (
    <div className="overlay" onClick={() => !busy && setPending(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Borrar {pending.id.toUpperCase()}</h2>
        {pending.risks.length > 0 && (
          <>
            <div>Se perdería trabajo:</div>
            <ul>
              {pending.risks.map((r) => (
                <li key={r.repo}>
                  <b>{r.repo}</b>:{' '}
                  {[
                    r.dirty ? 'cambios sin guardar' : '',
                    r.unpushed ? `${r.unpushed} commit${r.unpushed > 1 ? 's' : ''} sin subir` : ''
                  ]
                    .filter(Boolean)
                    .join(' y ')}
                </li>
              ))}
            </ul>
          </>
        )}
        {pending.processes.length > 0 && (
          <>
            <div>Hay programas usando esta sesión (no los abrió Agentify):</div>
            <ul>
              {pending.processes.map((p) => (
                <li key={p.pid} title={p.cmd}>
                  <b>{p.name}</b> <span className="muted mono">pid {p.pid} · {p.cmd.slice(0, 90)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button disabled={busy} onClick={() => setPending(null)}>
            Cancelar
          </button>
          <button className="primary" disabled={busy} onClick={() => run(pending.id, true)}>
            {busy ? 'Borrando…' : pending.processes.length ? 'Detenerlos y borrar' : 'Borrar de todos modos'}
          </button>
        </div>
      </div>
    </div>
  ) : null

  return { remove: (id) => run(id, false), dialog }
}
