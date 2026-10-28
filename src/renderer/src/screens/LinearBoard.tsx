import { useCallback, useEffect, useState } from 'react'
import type {
  AppConfig,
  BoardCard,
  BoardColumn,
  IssueDetail,
  IssueLink,
  TicketStatus
} from '../../../shared/api'
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

/** The board with one card moved to another column, before Linear confirms it. */
function moved(columns: BoardColumn[], identifier: string, to: string): BoardColumn[] {
  const card = columns.flatMap((c) => c.cards).find((c) => c.identifier === identifier)
  if (!card) return columns
  return columns.map((c) => {
    const cards = c.cards.filter((k) => k.identifier !== identifier)
    return c.name === to ? { ...c, cards: [{ ...card, state: to }, ...cards] } : { ...c, cards }
  })
}

function Card({
  c,
  done,
  moving,
  onOpen,
  onParent,
  onDrag
}: {
  c: BoardCard
  done: boolean
  moving: boolean
  onOpen: () => void
  onParent: () => void
  onDrag: (dragging: boolean) => void
}): React.JSX.Element {
  const p = PRIORITY[c.priority]
  const labels = c.labels.filter((l) => l.toLowerCase() !== c.bot?.label.toLowerCase())
  return (
    <div
      className={`kcard status-${c.status} ${done ? 'done' : ''} ${moving ? 'moving' : ''}`}
      data-ticket={c.identifier}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', c.identifier)
        e.dataTransfer.effectAllowed = 'move'
        onDrag(true)
      }}
      onDragEnd={() => onDrag(false)}
      onClick={onOpen}
    >
      <div className="kcard-top">
        <span className="id">{c.identifier}</span>
        {p && (
          <span className={`prio p${c.priority}`} title={`Prioridad ${p.label.toLowerCase()}`}>
            {p.icon}
          </span>
        )}
        {c.parent && (
          <button
            className="kparent"
            title={`Sub-ticket de ${c.parent}: abrir el padre`}
            onClick={(e) => {
              e.stopPropagation()
              onParent()
            }}
          >
            ↑ {c.parent}
          </button>
        )}
        <span className="spacer" />
        {c.children && (
          <span
            className={`kkids ${c.children.done === c.children.total ? 'all' : ''}`}
            title={`${c.children.done} de ${c.children.total} sub-tickets terminados`}
          >
            ▾ {c.children.done}/{c.children.total}
          </span>
        )}
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

function Family({
  title,
  links,
  onGo
}: {
  title: string
  links: IssueLink[]
  onGo: (identifier: string) => void
}): React.JSX.Element {
  return (
    <div className="kfamily">
      <div className="muted">{title}</div>
      {links.map((l) => (
        <button
          key={l.identifier}
          className={`klink status-${l.status} ${l.done ? 'done' : ''}`}
          data-link={l.identifier}
          onClick={() => onGo(l.identifier)}
        >
          <span className="id">{l.identifier}</span>
          <span className="klink-title">{l.title}</span>
          <span className="muted">{l.state}</span>
        </button>
      ))}
    </div>
  )
}

/**
 * One ticket, read again from Linear so its parent and sub-tickets show; those open here too, even
 * when they are someone else's. `seed` is the board's card, shown while Linear answers.
 */
function Drawer({
  cfg,
  id,
  seed,
  onBack,
  onGo,
  onClose,
  onStart,
  onAssigned
}: {
  cfg: AppConfig
  id: string
  seed?: BoardCard
  onBack?: () => void
  onGo: (identifier: string) => void
  onClose: () => void
  onStart: () => void
  onAssigned: () => void
}): React.JSX.Element {
  const bots = cfg.bots ?? []
  const [detail, setDetail] = useState<IssueDetail | null>(null)
  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.boardIssue(id).then(setDetail, (e) => setError(errorText(e)))
  }, [id])

  const c = detail ?? seed
  const why = c ? WHY_NOT[c.status] : null
  // A session starts from your own tickets: someone else's can be read and assigned, not started.
  const whyStart = why ?? (seed ? null : 'no está asignado a ti')

  const assign = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      await api.office.assign(botId, id)
      onAssigned()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const kids = detail?.children ?? []
  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <aside className="kdrawer" onClick={(e) => e.stopPropagation()}>
        <div className="row">
          {onBack && (
            <button className="ghost" onClick={onBack} title="Volver al ticket anterior">
              ← volver
            </button>
          )}
          <span className="id">{id}</span>
          {c && <span className="muted">{c.state}</span>}
          <span className="spacer" />
          <button className="ghost" onClick={onClose} title="Cerrar">
            ✕
          </button>
        </div>
        {!c && !error && <div className="muted">Leyendo {id} de Linear…</div>}
        {c && (
          <>
            <h2>{c.title}</h2>
            {detail?.assignee && !seed && <div className="muted">Asignado a {detail.assignee}</div>}
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
            {detail?.parent && <Family title="Padre" links={[detail.parent]} onGo={onGo} />}
            {kids.length > 0 && (
              <Family
                title={`Sub-tickets · ${kids.filter((k) => k.done).length}/${kids.length} terminados`}
                links={kids}
                onGo={onGo}
              />
            )}
            <div className="kdrawer-desc">
              {c.description.trim() || <span className="muted">Sin descripción.</span>}
            </div>
          </>
        )}
        {error && <div className="error">{error}</div>}
        {c && why && <div className="muted">No se puede iniciar ni asignar: {why}.</div>}
        {c && !why && whyStart && (
          <div className="muted">Para iniciar una sesión tiene que estar asignado a ti.</div>
        )}
        {c && (
          <div className="kdrawer-actions">
            <button
              className="primary"
              disabled={!!whyStart}
              title={whyStart ? `No se puede: ${whyStart}` : undefined}
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
        )}
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
  // The tickets opened one after another in the drawer: the last is on screen, ← volver pops it.
  const [trail, setTrail] = useState<string[]>([])
  const [starting, setStarting] = useState<string | null>(null)
  const [dragging, setDragging] = useState<BoardCard | null>(null)
  const [over, setOver] = useState<string | null>(null)
  const [moving, setMoving] = useState<string | null>(null)

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
  const open = trail.at(-1)

  /** The state id a dragged card would take in this column: its own team's, if the team has it. */
  const target = (col: BoardColumn): string | undefined =>
    dragging && col.name !== dragging.state
      ? col.states.find((s) => s.team === dragging.team)?.id
      : undefined

  const drop = async (col: BoardColumn): Promise<void> => {
    const card = dragging
    const stateId = target(col)
    setDragging(null)
    setOver(null)
    if (!card || !stateId) return
    setColumns((cols) => cols && moved(cols, card.identifier, col.name))
    setMoving(card.identifier)
    try {
      await api.boardMove(card.identifier, stateId)
    } catch (e) {
      setError(`No se pudo mover ${card.identifier} a ${col.name}: ${errorText(e)}`)
    } finally {
      setMoving(null)
      // What Linear says now: the move confirmed, or the card back where it was.
      void load()
    }
  }

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
        <div className={`kanban ${dragging ? 'dragging' : ''}`}>
          {columns.map((col) => {
            const ok = !!target(col)
            const home = dragging?.state === col.name
            return (
              <section
                key={col.name}
                className={`kcol ${dragging && !home ? (ok ? 'drop-ok' : 'drop-no') : ''} ${
                  over === col.name && ok ? 'over' : ''
                }`}
                data-column={col.name}
                title={
                  dragging && !home && !ok
                    ? `El equipo ${dragging.team} no tiene el estado ${col.name}`
                    : undefined
                }
                onDragOver={(e) => {
                  if (!ok) return
                  e.preventDefault()
                  e.dataTransfer.dropEffect = 'move'
                  if (over !== col.name) setOver(col.name)
                }}
                onDragLeave={() => over === col.name && setOver(null)}
                onDrop={(e) => {
                  e.preventDefault()
                  void drop(col)
                }}
              >
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
                      moving={moving === c.identifier}
                      onOpen={() => setTrail([c.identifier])}
                      onParent={() => c.parent && setTrail([c.identifier, c.parent])}
                      onDrag={(on) => {
                        setDragging(on ? c : null)
                        if (!on) setOver(null)
                      }}
                    />
                  ))}
                </div>
              </section>
            )
          })}
        </div>
      )}
      {open && (
        <Drawer
          key={open}
          cfg={cfg}
          id={open}
          seed={cards.find((c) => c.identifier === open)}
          onBack={trail.length > 1 ? () => setTrail((t) => t.slice(0, -1)) : undefined}
          onGo={(identifier) => setTrail((t) => [...t, identifier])}
          onClose={() => setTrail([])}
          onStart={() => {
            setTrail([])
            setStarting(open)
          }}
          onAssigned={() => {
            setTrail([])
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
