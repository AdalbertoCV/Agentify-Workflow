import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, BoardCard, BoardColumn, TicketStatus } from '../../../shared/api'
import { api, errorText, useInterval } from '../api'
import { NewSessionDialog } from './NewSessionDialog'
import { Avatar } from './Office'

// Linear has no push for a desktop app: read again every 30 s and whenever the window comes back.
const POLL_MS = 30_000

const PRIORITY: Record<number, { icon: string; label: string }> = {
  1: { icon: '‼', label: 'Urgente' },
  2: { icon: '▲', label: 'Alta' },
  3: { icon: '■', label: 'Media' },
  4: { icon: '▼', label: 'Baja' }
}

const WHY_NOT: Record<TicketStatus, string | null> = {
  ready: null,
  'in-progress': 'ya se está trabajando',
  'in-review': 'está en revisión',
  blocked: 'está bloqueado'
}

const DESK_LABEL = {
  working: 'trabajando',
  done: 'listo',
  'needs-you': 'te necesita',
  idle: 'en pausa'
}

function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000))
  if (s < 60) return `hace ${s} s`
  return `hace ${Math.round(s / 60)} min`
}

function Card({
  c,
  done,
  onOpen
}: {
  c: BoardCard
  done: boolean
  onOpen: () => void
}): React.JSX.Element {
  const p = PRIORITY[c.priority]
  const labels = c.labels.filter((l) => l.toLowerCase() !== c.bot?.label.toLowerCase())
  return (
    <div
      className={`kcard status-${c.status} ${done ? 'done' : ''}`}
      data-ticket={c.identifier}
      onClick={onOpen}
    >
      <div className="kcard-top">
        <span className="id">{c.identifier}</span>
        {p && (
          <span className={`prio p${c.priority}`} title={`Prioridad ${p.label.toLowerCase()}`}>
            {p.icon}
          </span>
        )}
        <span className="spacer" />
        {c.bot && (
          <span
            className={`kbot ${c.bot.status ?? ''}`}
            title={`${c.bot.name}${c.bot.status ? ` · ${DESK_LABEL[c.bot.status]}` : ''}`}
          >
            <Avatar avatar={c.bot.avatar} name={c.bot.name} />
            {c.bot.status && <span className="kbot-light" />}
          </span>
        )}
      </div>
      <div className="kcard-title">{c.title}</div>
      {c.status === 'blocked' && (
        <div className="kcard-blocked">
          Bloqueado{c.blockedBy?.length ? ` por ${c.blockedBy.join(', ')}` : ''}
        </div>
      )}
      {labels.length > 0 && (
        <div className="kcard-labels">
          {labels.map((l) => (
            <span key={l} className="chip">
              {l}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

function Drawer({
  cfg,
  c,
  onClose,
  onStart,
  onAssigned
}: {
  cfg: AppConfig
  c: BoardCard
  onClose: () => void
  onStart: () => void
  onAssigned: () => void
}): React.JSX.Element {
  const bots = cfg.bots ?? []
  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const why = WHY_NOT[c.status]

  const assign = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.office.assign(botId, c.identifier)
      onAssigned()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <aside className="kdrawer" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <span className="id">{c.identifier}</span>
          <span className="muted">{c.state}</span>
          <span className="spacer" />
          <button className="ghost" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>
        <h2>{c.title}</h2>
        {c.bot && (
          <div className="row">
            <Avatar avatar={c.bot.avatar} name={c.bot.name} />
            <span>
              Lo trabaja <b>{c.bot.name}</b>
              {c.bot.status ? ` · ${DESK_LABEL[c.bot.status]}` : ''}
            </span>
          </div>
        )}
        {c.status === 'blocked' && (
          <div className="error">
            Bloqueado{c.blockedBy?.length ? ` por ${c.blockedBy.join(', ')}` : ''}
          </div>
        )}
        <div className="kdrawer-desc">
          {c.description.trim() || <span className="muted">Sin descripción.</span>}
        </div>
        {error && <div className="error">{error}</div>}
        {why && <div className="muted">No se puede iniciar ni asignar: {why}.</div>}
        <div className="kdrawer-actions">
          <button
            className="primary"
            disabled={!!why}
            title={why ? `No se puede: ${why}` : undefined}
            onClick={onStart}
          >
            Iniciar sesión
          </button>
          {bots.length > 0 && !c.bot && (
            <div className="row">
              {bots.length > 1 && (
                <select value={botId} onChange={(e) => setBotId(e.target.value)}>
                  {bots.map((b) => (
                    <option key={b.id} value={b.id}>
                      {b.avatar} {b.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                disabled={busy || !!why}
                title={why ? `No se puede: ${why}` : undefined}
                onClick={assign}
              >
                {busy ? 'Asignando…' : `Asignar a ${bots.length > 1 ? 'bot' : bots[0].name}`}
              </button>
            </div>
          )}
          <button className="ghost" onClick={() => void api.openExternal(c.url)}>
            Abrir en Linear ↗
          </button>
        </div>
      </aside>
    </div>
  )
}

/** Your Linear tickets by state, live, with the bots' avatars on the ones they work. */
export function LinearBoard({
  cfg,
  onOpenSession,
  onConnect
}: {
  cfg: AppConfig
  onOpenSession: (id: string) => void
  onConnect: () => void
}): React.JSX.Element {
  const [columns, setColumns] = useState<BoardColumn[] | null>(null)
  const [error, setError] = useState('')
  const [loadedAt, setLoadedAt] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [open, setOpen] = useState<string | null>(null)
  const [starting, setStarting] = useState<string | null>(null)

  const load = useCallback(
    (): Promise<void> =>
      api.board().then(
        (cols) => {
          setColumns(cols)
          setError('')
          setLoadedAt(Date.now())
        },
        (e) => setError(errorText(e))
      ),
    []
  )

  useEffect(() => {
    void load()
    const onFocus = (): void => void load()
    window.addEventListener('focus', onFocus)
    const off = api.office.onChanged(() => void load())
    return () => {
      window.removeEventListener('focus', onFocus)
      off()
    }
  }, [load])
  useInterval(() => void load(), POLL_MS)
  useInterval(() => setNow(Date.now()), 1000)

  const cards = (columns ?? []).flatMap((c) => c.cards)
  const card = cards.find((c) => c.identifier === open)

  return (
    <div className="page kpage">
      <div className="page-head">
        <h1>Tablero</h1>
        <span className="muted">{cards.length}</span>
        <span className="spacer" />
        {loadedAt > 0 && (
          <span className="muted" title="Se actualiza cada 30 s y al volver a la ventana">
            actualizado {ago(loadedAt, now)}
          </span>
        )}
        <button className="ghost" onClick={() => void load()} title="Leer Linear ahora">
          ⟳
        </button>
      </div>
      {error && (
        <div className="row">
          <span className="error">{error}</span>
          <button className="ghost" onClick={onConnect}>
            Conectores →
          </button>
        </div>
      )}
      {columns === null && !error && <div className="muted">Leyendo Linear…</div>}
      {columns && (
        <div className="kanban">
          {columns.map((col) => (
            <section key={col.name} className="kcol">
              <header>
                <span
                  className="kcol-dot"
                  style={col.color ? { background: col.color } : undefined}
                />
                <span>{col.name}</span>
                <span className="muted">{col.cards.length}</span>
              </header>
              <div className="kcol-cards">
                {col.cards.map((c) => (
                  <Card
                    key={c.identifier}
                    c={c}
                    done={col.type === 'completed'}
                    onOpen={() => setOpen(c.identifier)}
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
      {card && (
        <Drawer
          cfg={cfg}
          c={card}
          onClose={() => setOpen(null)}
          onStart={() => {
            setOpen(null)
            setStarting(card.identifier)
          }}
          onAssigned={() => {
            setOpen(null)
            void load()
          }}
        />
      )}
      {starting && (
        <NewSessionDialog
          cfg={cfg}
          initialTicket={starting}
          onClose={() => setStarting(null)}
          onConnect={() => {
            setStarting(null)
            onConnect()
          }}
          onCreated={(s) => {
            setStarting(null)
            onOpenSession(s.id)
          }}
        />
      )}
    </div>
  )
}
