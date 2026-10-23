import { useEffect, useState } from 'react'
import type { Check } from '../../../shared/api'
import { api, errorText } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'

export function Connectors({ onChecked }: { onChecked: (failing: number) => void }): React.JSX.Element {
  const [checks, setChecks] = useState<Check[] | null>(null)
  const [error, setError] = useState('')
  const [secretFor, setSecretFor] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const [fixTerminal, setFixTerminal] = useState<{ id: string; command: string } | null>(null)

  const load = async (): Promise<void> => {
    setChecks(null)
    setError('')
    try {
      const c = await api.connectors()
      setChecks(c)
      onChecked(c.filter((x) => !x.ok).length)
    } catch (e) {
      setError(errorText(e))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const fix = async (c: Check): Promise<void> => {
    if (!c.fix) return
    if (c.fix.kind === 'link') return api.openExternal(c.fix.value)
    if (c.fix.kind === 'secret') {
      setSecret('')
      setSecretFor(c.fix.value)
      return
    }
    setFixTerminal({ id: await api.runFix(c.fix.value), command: c.fix.value })
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Conectores</h1>
        <span className="muted">Lo que la app necesita para que todo funcione.</span>
        <span className="spacer" />
        <button onClick={load}>Volver a revisar</button>
      </div>
      {error && <div className="error">{error}</div>}
      {!checks && !error && <div className="muted">Revisando…</div>}
      <div className="list">
        {checks?.map((c) => (
          <div className="item" key={c.id}>
            <span className={`dot ${c.ok ? 'ok' : 'bad'}`} />
            <span className="name">{c.label}</span>
            <span className="detail" title={c.detail}>
              {c.detail}
            </span>
            {!c.ok && c.fix && (
              <>
                {c.fix.kind === 'command' && (
                  <button className="ghost" title={c.fix.value} onClick={() => navigator.clipboard.writeText(c.fix!.value)}>
                    Copiar comando
                  </button>
                )}
                <button className="primary" onClick={() => fix(c)}>
                  {c.fix.kind === 'link' ? 'Descargar' : c.fix.kind === 'secret' ? 'Conectar' : 'Arreglar aquí'}
                </button>
              </>
            )}
          </div>
        ))}
      </div>

      {secretFor && (
        <div className="overlay" onClick={() => setSecretFor(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Conectar Linear</h2>
            <div className="muted">
              Crea una llave personal en Linear → Settings → Account → Security &amp; access → Personal API keys, y pégala
              aquí. Se guarda cifrada en esta máquina.
            </div>
            <button className="ghost" style={{ alignSelf: 'flex-start' }} onClick={() => api.openExternal('https://linear.app/settings/account/security')}>
              Abrir Linear →
            </button>
            <input type="password" autoFocus placeholder="lin_api_…" value={secret} onChange={(e) => setSecret(e.target.value)} />
            <div className="row end">
              <button onClick={() => setSecretFor(null)}>Cancelar</button>
              <button
                className="primary"
                disabled={!secret.trim()}
                onClick={async () => {
                  await api.secrets.set(secretFor, secret.trim())
                  setSecretFor(null)
                  void load()
                }}
              >
                Guardar
              </button>
            </div>
          </div>
        </div>
      )}

      {fixTerminal && (
        <div className="overlay">
          <div className="modal wide">
            <div className="row">
              <h2>Arreglando</h2>
              <span className="mono muted">{fixTerminal.command}</span>
              <span className="spacer" />
              <button
                onClick={() => {
                  setFixTerminal(null)
                  void load()
                }}
              >
                Cerrar y revisar
              </button>
            </div>
            <div className="term-box" style={{ flex: 1 }}>
              <AgentTerminal id={fixTerminal.id} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
