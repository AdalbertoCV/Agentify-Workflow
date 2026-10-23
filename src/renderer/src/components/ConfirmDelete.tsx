import { useEffect, useState } from 'react'
import type { DeleteProgress, DeleteStep } from '../../../shared/api'
import { api, errorText } from '../api'

function seconds(ms?: number): string {
  return ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`
}

const ICON = { pending: '·', running: '⏳', done: '✓', failed: '✗' }

/**
 * Every delete asks first, then shows each step until the session is gone. The work runs in the
 * main process: closing the dialog does not stop it, and opening it again shows where it is.
 */
export function useDelete(onDeleted: () => void): {
  remove: (id: string) => Promise<void>
  dialog: React.JSX.Element | null
} {
  const [p, setP] = useState<DeleteProgress | null>(null)
  const [error, setError] = useState('')

  useEffect(
    () =>
      api.deletion.onProgress((next) => {
        setP((cur) => (cur && cur.id === next.id ? next : cur))
      }),
    []
  )

  useEffect(() => {
    if (p?.phase !== 'deleted') return
    const t = setTimeout(() => {
      setP(null)
      onDeleted()
    }, 1200)
    return () => clearTimeout(t)
  }, [p?.phase, onDeleted])

  const remove = async (id: string): Promise<void> => {
    setError('')
    try {
      setP(await api.deletion.plan(id))
    } catch (e) {
      setError(errorText(e))
      setP({ id, phase: 'failed', plan: { risks: [], processes: [], steps: [] }, steps: [] })
    }
  }

  const start = async (): Promise<void> => {
    if (!p) return
    setError('')
    try {
      await api.deletion.start(p.id)
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (!p) return { remove, dialog: null }
  const asking = p.phase === 'confirm' || p.phase === 'paused'
  const { risks, processes } = p.plan

  const dialog = (
    <div className="overlay" onClick={() => asking && setP(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Borrar {p.id.toUpperCase()}</h2>
        {p.phase === 'paused' && <div className="error">Apareció algo nuevo desde que confirmaste. Revísalo:</div>}
        {asking && risks.length > 0 && (
          <>
            <div>Se perdería trabajo:</div>
            <ul>
              {risks.map((r) => (
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
        {asking && processes.length > 0 && (
          <>
            <div>Hay programas usando esta sesión (no los abrió Agentify-Workflow):</div>
            <ul>
              {processes.map((x) => (
                <li key={x.pid} title={x.cmd}>
                  <b>{x.name}</b> <span className="muted mono">pid {x.pid} · {x.cmd.slice(0, 90)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        {p.phase === 'confirm' && <div className="muted">Se va a quitar:</div>}
        <div className="del-steps">
          {p.steps.map((s: DeleteStep) => (
            <div key={s.id} className={`del-step ${s.state}`}>
              <span className="del-icon">{ICON[s.state]}</span>
              <span className="del-label">{s.label}</span>
              <span className="muted mono">{s.state === 'failed' ? '' : seconds(s.ms)}</span>
              {s.error && <div className="error del-error">{s.error}</div>}
            </div>
          ))}
        </div>
        {p.phase === 'deleted' && <div className="ok-text">Sesión borrada</div>}
        {(error || p.error) && <div className="error">{error || p.error}</div>}
        <div className="row end">
          {asking ? (
            <>
              <button onClick={() => setP(null)}>Cancelar</button>
              <button className="primary danger-bg" onClick={start}>
                {processes.length ? 'Detenerlos y borrar' : risks.length ? 'Borrar de todos modos' : 'Borrar'}
              </button>
            </>
          ) : p.phase === 'failed' ? (
            <>
              <button onClick={() => setP(null)}>Cerrar</button>
              {p.plan.steps.length > 0 && (
                <button className="primary" onClick={start}>
                  Reintentar
                </button>
              )}
            </>
          ) : p.phase === 'running' ? (
            <button title="El borrado sigue; la tarjeta muestra que está en curso" onClick={() => setP(null)}>
              Cerrar
            </button>
          ) : null}
        </div>
      </div>
    </div>
  )

  return { remove, dialog }
}
