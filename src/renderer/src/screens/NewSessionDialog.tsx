import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, Issue, Session, TicketProviderId, TicketStatus } from '../../../shared/api'
import { api, errorText } from '../api'

// Why a ticket cannot start a session; ready tickets have none.
const WHY_NOT: Record<TicketStatus, string | null> = {
  ready: null,
  'in-progress': 'En progreso: ya se está trabajando',
  'in-review': 'En revisión',
  blocked: 'Bloqueado'
}

const PROVIDER_LABEL: Record<TicketProviderId, string> = {
  linear: 'Linear',
  github: 'GitHub Issues',
  manual: 'Manual'
}

export function NewSessionDialog({
  cfg,
  onClose,
  onCreated,
  onConnect,
  initialTicket
}: {
  cfg: AppConfig
  /** Comes from the board: that ticket is picked as soon as the list loads. */
  initialTicket?: string
  onClose: () => void
  onCreated: (s: Session) => void
  onConnect: () => void
}): React.JSX.Element {
  const [provider, setProvider] = useState<TicketProviderId | null>(null)
  const [issues, setIssues] = useState<Issue[]>([])
  const [issuesError, setIssuesError] = useState('')
  const [loaded, setLoaded] = useState(false)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState<string>('')
  const [ticket, setTicket] = useState('')
  const [title, setTitle] = useState('')
  const [repos, setRepos] = useState<string[]>([])
  const [agent, setAgent] = useState(cfg.defaultAgent)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<string[]>([])
  const [error, setError] = useState('')
  const progressEl = useRef<HTMLDivElement>(null)

  useEffect(() => {
    void api.tickets.provider().then(async (p) => {
      setProvider(p)
      if (p === 'manual') return
      try {
        const list = await api.tickets.list()
        setIssues(list)
        setLoaded(true)
        // Opened from the board: that ticket comes picked.
        const preset = list.find((i) => i.identifier === initialTicket)
        if (preset) {
          setPicked(preset.identifier)
          setTicket(preset.identifier)
          setTitle(preset.title)
          const fromTicket = await api.tickets.reposFor(preset)
          if (fromTicket.length) setRepos(fromTicket)
        }
      } catch (e) {
        setIssuesError(errorText(e))
      }
    })
    return api.onProgress((m) => setProgress((p) => [...p, m]))
  }, [initialTicket])

  useEffect(() => {
    progressEl.current?.scrollTo(0, progressEl.current.scrollHeight)
  }, [progress])

  // Tickets you can start first; the rest stay visible so you see why they are not offered.
  const filtered = useMemo(() => {
    const q = query.toLowerCase()
    return issues
      .filter(
        (i) => !q || i.identifier.toLowerCase().includes(q) || i.title.toLowerCase().includes(q)
      )
      .sort((a, b) => Number(b.status === 'ready') - Number(a.status === 'ready'))
  }, [issues, query])

  const pick = async (i: Issue): Promise<void> => {
    setPicked(i.identifier)
    setTicket(i.identifier)
    setTitle(i.title)
    const fromTicket = await api.tickets.reposFor(i)
    if (fromTicket.length) setRepos(fromTicket)
  }

  const toggle = (name: string): void =>
    setRepos((r) => (r.includes(name) ? r.filter((x) => x !== name) : [...r, name]))

  const create = async (): Promise<void> => {
    setBusy(true)
    setError('')
    setProgress([])
    try {
      onCreated(await api.createSession({ ticket, title, repos, agent }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Nueva sesión</h2>

        {provider && provider !== 'manual' && issuesError && (
          <div className="row">
            <span className="error">
              {PROVIDER_LABEL[provider]} no respondió: {issuesError}
            </span>
            <button className="ghost" onClick={onConnect}>
              Conectores →
            </button>
          </div>
        )}
        {provider && provider !== 'manual' && !issuesError && (
          <div className="field">
            <label>Tus tickets</label>
            <input
              placeholder="Buscar por número o título"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="issues">
              {!issues.length && (
                <div className="muted" style={{ padding: 10 }}>
                  {loaded ? 'No tienes tickets abiertos asignados.' : 'Cargando…'}
                </div>
              )}
              {filtered.map((i) => {
                const why = WHY_NOT[i.status]
                return (
                  <div
                    key={i.identifier}
                    className={`issue status-${i.status} ${why ? 'disabled' : ''} ${picked === i.identifier ? 'on' : ''}`}
                    title={why ? `No se puede elegir: ${why.toLowerCase()}` : undefined}
                    onClick={() => !why && pick(i)}
                  >
                    <span className="status-dot" />
                    <span className="id">{i.identifier}</span>
                    <span className="issue-text">
                      <span>{i.title}</span>
                      {why && (
                        <span className="issue-why">
                          {i.status === 'blocked' && i.blockedBy?.length
                            ? `Bloqueado por ${i.blockedBy.join(', ')}`
                            : why}
                        </span>
                      )}
                    </span>
                    <span className="issue-state">{i.state}</span>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div className="row">
          <div className="field" style={{ width: 160 }}>
            <label>Ticket</label>
            <input
              value={ticket}
              placeholder="ENG-123"
              onChange={(e) => setTicket(e.target.value)}
            />
          </div>
          <div className="field" style={{ flex: 1 }}>
            <label>Título</label>
            <input value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
        </div>

        <div className="field">
          <label>Repos que toca {picked && repos.length ? '(leídos del ticket)' : ''}</label>
          <div className="checks">
            {cfg.repos.map((r) => (
              <div
                key={r.name}
                className={`check ${repos.includes(r.name) ? 'on' : ''}`}
                onClick={() => toggle(r.name)}
              >
                <input type="checkbox" readOnly checked={repos.includes(r.name)} />
                <span>{r.name}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="field" style={{ width: 240 }}>
          <label>Agente</label>
          <select value={agent} onChange={(e) => setAgent(e.target.value)}>
            {cfg.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </div>

        {progress.length > 0 && (
          <div className="progress" ref={progressEl}>
            {progress.join('\n')}
          </div>
        )}
        {error && <div className="error">{error}</div>}

        <div className="row end">
          <button disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button
            className="primary"
            disabled={busy || !ticket.trim() || !repos.length}
            onClick={create}
          >
            {busy ? 'Creando…' : 'Crear sesión'}
          </button>
        </div>
      </div>
    </div>
  )
}
