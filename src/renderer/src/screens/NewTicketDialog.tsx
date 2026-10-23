import { useEffect, useState } from 'react'
import type { TicketProviderId } from '../../../shared/api'
import { api, errorText } from '../api'
import { AgentTerminal } from '../components/AgentTerminal'

const LABEL: Record<TicketProviderId, string> = {
  linear: 'Linear',
  github: 'GitHub Issues',
  manual: 'Manual'
}

/** Describe the problem; the session's default agent writes the ticket in the active provider. */
export function NewTicketDialog({
  onClose,
  onConnect
}: {
  onClose: () => void
  onConnect: () => void
}): React.JSX.Element {
  const [provider, setProvider] = useState<TicketProviderId | null>(null)
  const [repos, setRepos] = useState<{ slug: string; repo?: string }[]>([])
  const [repo, setRepo] = useState('')
  const [context, setContext] = useState('')
  const [terminal, setTerminal] = useState<string | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    void api.tickets.provider().then(async (p) => {
      setProvider(p)
      if (p !== 'github') return
      const list = await api.tickets.githubRepos()
      setRepos(list)
      setRepo(list[0]?.slug ?? '')
    })
  }, [])

  const start = async (): Promise<void> => {
    setError('')
    try {
      setTerminal(await api.tickets.createStart(context, provider === 'github' ? repo : undefined))
    } catch (e) {
      setError(errorText(e))
    }
  }

  if (terminal)
    return (
      <div className="overlay">
        <div className="modal wide">
          <div className="row">
            <h2>Creando ticket en {provider ? LABEL[provider] : ''}</h2>
            <span className="muted">Contéstale al agente aquí si te pregunta algo.</span>
            <span className="spacer" />
            <button
              title="Cierra también al agente de este ticket"
              onClick={() => void api.pty.close(terminal).finally(onClose)}
            >
              Cerrar
            </button>
          </div>
          <div className="term-box" style={{ flex: 1 }}>
            <AgentTerminal id={terminal} />
          </div>
        </div>
      </div>
    )

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nuevo ticket</h2>
        {provider === 'manual' ? (
          <div className="row">
            <span className="muted">
              Con tickets manuales no hay dónde crearlos. Elige Linear o GitHub Issues.
            </span>
            <button className="ghost" onClick={onConnect}>
              Conectores →
            </button>
          </div>
        ) : (
          <>
            <div className="muted">
              El agente lo escribe y lo crea en {provider ? LABEL[provider] : '…'}; si le falta
              algo, te pregunta.
            </div>
            {provider === 'github' && (
              <div className="field">
                <label>Repo</label>
                <select value={repo} onChange={(e) => setRepo(e.target.value)}>
                  {repos.map((r) => (
                    <option key={r.slug} value={r.slug}>
                      {r.slug}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <div className="field">
              <label>Contexto</label>
              <textarea
                className="ticket-context"
                autoFocus
                placeholder="Qué pasa, dónde lo viste, qué esperabas…"
                value={context}
                onChange={(e) => setContext(e.target.value)}
              />
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancelar</button>
          <button
            className="primary"
            disabled={
              !provider ||
              provider === 'manual' ||
              !context.trim() ||
              (provider === 'github' && !repo)
            }
            onClick={start}
          >
            Crear con el agente
          </button>
        </div>
      </div>
    </div>
  )
}
