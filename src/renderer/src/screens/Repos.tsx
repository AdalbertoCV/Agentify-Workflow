import { useEffect, useState } from 'react'
import type { AppConfig, OnboardResult, OnboardStart } from '../../../shared/api'
import { api, errorText, useInterval } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'

export function Repos({ cfg, onSaved }: { cfg: AppConfig; onSaved: (c: AppConfig) => void }): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [onboard, setOnboard] = useState<OnboardStart | null>(null)
  const [result, setResult] = useState<OnboardResult | null>(null)
  const [resultError, setResultError] = useState('')
  const [golden, setGolden] = useState<Record<string, string | null>>({})
  const [recopying, setRecopying] = useState('')
  const [goldenError, setGoldenError] = useState('')

  useEffect(() => {
    void api.repos.goldenInfo().then(setGolden).catch(() => {})
  }, [recopying])

  const recopy = async (name: string): Promise<void> => {
    setRecopying(name)
    setGoldenError('')
    try {
      await api.repos.refreshGolden(name)
    } catch (e) {
      setGoldenError(errorText(e))
    } finally {
      setRecopying('')
    }
  }

  const begin = async (src: { cloneUrl?: string; path?: string }): Promise<void> => {
    setBusy(true)
    setError('')
    setResult(null)
    setResultError('')
    try {
      setOnboard(await api.repos.startOnboarding(src))
      setAdding(false)
      setSource('')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  useInterval(
    async () => {
      if (!onboard || result) return
      try {
        const r = await api.repos.readOnboarding(onboard.workDir)
        if (r) setResult(r)
        setResultError('')
      } catch (e) {
        setResultError(errorText(e))
      }
    },
    onboard ? 2000 : null
  )

  return (
    <div className="page">
      <div className="page-head">
        <h1>Repos</h1>
        <span className="muted">Cada repo sabe cómo levantarse con su run.sh. El agente lo escribe por ti.</span>
        <span className="spacer" />
        <button className="primary" onClick={() => setAdding(true)}>
          + Agregar repo
        </button>
      </div>
      {goldenError && <div className="error" style={{ marginBottom: 12 }}>{goldenError}</div>}
      <div className="list">
        {cfg.repos.map((r) => (
          <div className="item" key={r.name}>
            <span className={`dot ${r.run ? 'ok' : ''}`} />
            <span className="name">{r.name}</span>
            <span className="detail mono" title={r.path}>
              {r.trunk} · {r.run ? r.run.script : 'sin script de arranque'}
              {r.db ? ' · base propia por sesión' : ''}
              {r.run?.needs?.length ? ` · necesita ${r.run.needs.join(', ')}` : ''}
            </span>
            {r.db && (
              <button
                title={golden[r.name] ? `Base madre copiada ${new Date(golden[r.name]!).toLocaleString()}` : 'Aún sin base madre'}
                disabled={!!recopying}
                onClick={() => recopy(r.name)}
              >
                {recopying === r.name ? 'Trabajando…' : r.db.source === 'empty' ? 'Reconstruir base madre' : 'Recopiar mi base local'}
              </button>
            )}
            <button onClick={() => begin({ path: r.path })} disabled={busy}>
              {r.run ? 'Regenerar' : 'Generar con el agente'}
            </button>
          </div>
        ))}
      </div>

      {adding && (
        <div className="overlay" onClick={() => !busy && setAdding(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Agregar repo</h2>
            <div className="field">
              <label>URL para clonar, o ruta de una carpeta que ya existe</label>
              <input
                autoFocus
                value={source}
                placeholder="https://github.com/org/repo.git  ·  C:\ruta\al\repo"
                onChange={(e) => setSource(e.target.value)}
              />
            </div>
            <div className="muted">
              Lo clono en {cfg.root} y abro al agente para que lea el repo y escriba cómo levantarlo. Tú revisas y guardas.
            </div>
            {error && <div className="error">{error}</div>}
            <div className="row end">
              <button disabled={busy} onClick={() => setAdding(false)}>
                Cancelar
              </button>
              <button
                className="primary"
                disabled={busy || !source.trim()}
                onClick={() =>
                  begin(/^(https?:|git@|ssh:)/.test(source.trim()) ? { cloneUrl: source.trim() } : { path: source.trim() })
                }
              >
                {busy ? 'Preparando…' : 'Continuar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {onboard && (
        <div className="overlay">
          <div className="modal wide">
            <div className="row">
              <h2>Configurando {onboard.repoName}</h2>
              <span className="muted">
                {result ? 'Listo para revisar.' : 'El agente está leyendo el repo y escribiendo su run.sh…'}
              </span>
              <span className="spacer" />
              <button onClick={() => setOnboard(null)}>Cerrar</button>
            </div>
            <div className="split">
              <div className="term-box">
                <AgentTerminal id={onboard.terminalId} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, overflow: 'auto' }}>
                {resultError && <div className="error">{resultError}</div>}
                {!result && !resultError && (
                  <div className="muted">Cuando el agente escriba repo.json aparecerá aquí para que lo revises.</div>
                )}
                {result && (
                  <>
                    <div className="field">
                      <label>run.sh</label>
                      <pre className="preview">{result.runScript}</pre>
                    </div>
                    {result.stopScript && (
                      <div className="field">
                        <label>stop.sh</label>
                        <pre className="preview">{result.stopScript}</pre>
                      </div>
                    )}
                    <div className="field">
                      <label>Configuración</label>
                      <pre className="preview">{JSON.stringify({ ...result.repo, path: undefined }, null, 2)}</pre>
                    </div>
                    <div className="row end">
                      <button onClick={() => setResult(null)}>Seguir esperando cambios</button>
                      <button
                        className="primary"
                        onClick={async () => {
                          onSaved(await api.repos.save(result.repo))
                          setOnboard(null)
                        }}
                      >
                        Guardar
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
