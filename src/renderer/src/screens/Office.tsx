import { useEffect, useState } from 'react'
import type { AppConfig, BotConfig, Desk, Issue } from '../../../shared/api'
import { api, errorText } from '../api'

const STATUS: Record<Desk['status'], { label: string; cls: string }> = {
  working: { label: 'Trabajando', cls: 'working' },
  done: { label: 'Terminado', cls: 'done' },
  'needs-you': { label: 'Te necesita', cls: 'needs-you' },
  idle: { label: 'Sin actividad', cls: 'idle' }
}

function Avatar({ avatar, name }: { avatar?: string; name: string }): React.JSX.Element {
  if (avatar && /^(https?:|data:|file:)/.test(avatar))
    return <img className="bot-avatar" src={avatar} alt="" />
  return <span className="bot-avatar">{avatar || name.slice(0, 1)}</span>
}

const EMPTY_BOT: BotConfig = {
  id: '',
  name: '',
  avatar: '🤖',
  routineId: '',
  label: '',
  commentPrefix: '',
  readyCheck: '',
  autoIterate: true
}

/** Set up the bots: what each routine is called, how to recognise its work, and its token. */
function BotsDialog({
  cfg,
  onClose,
  onSaved
}: {
  cfg: AppConfig
  onClose: () => void
  onSaved: (c: AppConfig) => void
}): React.JSX.Element {
  const [bots, setBots] = useState<BotConfig[]>(cfg.bots?.length ? cfg.bots : [{ ...EMPTY_BOT }])
  const [tokens, setTokens] = useState<Record<string, string>>({})
  const [has, setHas] = useState<Record<string, boolean>>({})
  const [error, setError] = useState('')

  useEffect(() => {
    void Promise.all(
      (cfg.bots ?? []).map(async (b) => [b.id, await api.bots.hasToken(b.id)] as const)
    ).then((pairs) => setHas(Object.fromEntries(pairs)))
  }, [cfg.bots])

  const set = (i: number, patch: Partial<BotConfig>): void =>
    setBots((bs) => bs.map((b, j) => (j === i ? { ...b, ...patch } : b)))

  const save = async (): Promise<void> => {
    const ready = bots
      .filter((b) => b.name.trim())
      .map((b) => ({
        ...b,
        id:
          b.id ||
          b.name
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-'),
        readyCheck: b.readyCheck?.trim() || undefined
      }))
    const missing = ready.find(
      (b) => !b.routineId.startsWith('trig_') || !b.label || !b.commentPrefix
    )
    if (missing)
      return setError(
        `${missing.name}: falta el id de la routine (trig_…), la etiqueta o el prefijo`
      )
    try {
      const byId = Object.fromEntries(
        Object.entries(tokens)
          .map(([i, t]) => [ready[Number(i)]?.id, t])
          .filter(([id]) => id)
      )
      onSaved(await api.bots.save(ready, byId))
      onClose()
    } catch (e) {
      setError(errorText(e))
    }
  }

  return (
    <div className="overlay" onClick={onClose}>
      <div className="modal wide bots-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Bots</h2>
        <div className="muted">
          Cada bot es una routine de Claude Code. En claude.ai/code/routines, en el trigger de la
          routine, elige API y genera un token. Su prompt debe leer el ticket del bloque
          routine-fire-payload.
        </div>
        {bots.map((b, i) => (
          <div key={i} className="bot-form">
            <div className="row">
              <input
                className="bot-emoji"
                value={b.avatar ?? ''}
                onChange={(e) => set(i, { avatar: e.target.value })}
                title="Avatar: emoji o URL de imagen"
              />
              <input
                placeholder="Nombre (Nova-Bot)"
                value={b.name}
                onChange={(e) => set(i, { name: e.target.value })}
              />
              <input
                placeholder="Id de la routine (trig_…)"
                value={b.routineId}
                onChange={(e) => set(i, { routineId: e.target.value.trim() })}
              />
            </div>
            <div className="row">
              <input
                placeholder="Etiqueta del ticket (nova-bot)"
                value={b.label}
                onChange={(e) => set(i, { label: e.target.value })}
              />
              <input
                placeholder="Prefijo de sus comentarios (Nova-Bot ·)"
                value={b.commentPrefix}
                onChange={(e) => set(i, { commentPrefix: e.target.value })}
              />
              <input
                placeholder="Check de listo (opcional)"
                value={b.readyCheck ?? ''}
                onChange={(e) => set(i, { readyCheck: e.target.value })}
              />
            </div>
            <div className="row">
              <input
                type="password"
                placeholder={
                  has[b.id]
                    ? 'Token guardado (escribe para cambiarlo)'
                    : 'Token de la routine (sk-ant-oat01-…)'
                }
                value={tokens[i] ?? ''}
                onChange={(e) => setTokens((t) => ({ ...t, [i]: e.target.value }))}
              />
              <label className="check-inline">
                <input
                  type="checkbox"
                  checked={!!b.autoIterate}
                  onChange={(e) => set(i, { autoIterate: e.target.checked })}
                />
                Vigilar sus PR e iterar solo
              </label>
              <button
                className="ghost danger"
                onClick={() => setBots((bs) => bs.filter((_, j) => j !== i))}
              >
                Quitar
              </button>
            </div>
          </div>
        ))}
        <button
          className="ghost"
          style={{ alignSelf: 'flex-start' }}
          onClick={() => setBots((bs) => [...bs, { ...EMPTY_BOT }])}
        >
          + Otro bot
        </button>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button onClick={onClose}>Cancelar</button>
          <button className="primary" onClick={save}>
            Guardar
          </button>
        </div>
      </div>
    </div>
  )
}

/** Pick a bot and one of your ready tickets: the bot gets its label and starts in the cloud. */
function AssignDialog({
  bots,
  onClose,
  onDone
}: {
  bots: BotConfig[]
  onClose: () => void
  onDone: (desks: Desk[]) => void
}): React.JSX.Element {
  const [botId, setBotId] = useState(bots[0]?.id ?? '')
  const [issues, setIssues] = useState<Issue[] | null>(null)
  const [query, setQuery] = useState('')
  const [picked, setPicked] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api.tickets.list().then(setIssues, (e) => setError(errorText(e)))
  }, [])

  const ready = (issues ?? [])
    .filter((i) => i.status === 'ready')
    .filter(
      (i) => !query || `${i.identifier} ${i.title}`.toLowerCase().includes(query.toLowerCase())
    )

  const assign = async (): Promise<void> => {
    setBusy(true)
    setError('')
    try {
      onDone(await api.office.assign(botId, picked))
      onClose()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="overlay" onClick={() => !busy && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Asignar ticket</h2>
        <div className="field">
          <label>Bot</label>
          <select value={botId} onChange={(e) => setBotId(e.target.value)}>
            {bots.map((b) => (
              <option key={b.id} value={b.id}>
                {b.avatar} {b.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Ticket (sólo los listos para empezar)</label>
          <input
            placeholder="Buscar"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <div className="issues">
            {!issues && !error && (
              <div className="muted" style={{ padding: 10 }}>
                Cargando…
              </div>
            )}
            {issues && !ready.length && (
              <div className="muted" style={{ padding: 10 }}>
                No hay tickets listos.
              </div>
            )}
            {ready.map((i) => (
              <div
                key={i.identifier}
                className={`issue status-ready ${picked === i.identifier ? 'on' : ''}`}
                onClick={() => setPicked(i.identifier)}
              >
                <span className="status-dot" />
                <span className="id">{i.identifier}</span>
                <span className="issue-text">{i.title}</span>
              </div>
            ))}
          </div>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row end">
          <button disabled={busy} onClick={onClose}>
            Cancelar
          </button>
          <button className="primary" disabled={busy || !picked || !botId} onClick={assign}>
            {busy ? 'Asignando…' : 'Asignar y arrancar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function DeskCard({
  d,
  focused,
  onDesks
}: {
  d: Desk
  focused: boolean
  onDesks: (desks: Desk[]) => void
}): React.JSX.Element {
  const [answer, setAnswer] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const s = STATUS[d.status]

  const act = async (label: string, work: () => Promise<Desk[]>): Promise<void> => {
    setBusy(label)
    setError('')
    try {
      onDesks(await work())
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  return (
    <div className={`desk ${s.cls} ${focused ? 'focused' : ''}`} id={`desk-${d.key}`}>
      <div className="desk-top">
        <Avatar avatar={d.avatar} name={d.botName} />
        <div className="desk-who">
          <b>{d.botName}</b>
          <span className={`desk-status ${s.cls}`}>
            <span className="dot" /> {s.label}
          </span>
        </div>
        <span className="spacer" />
        <button
          className="ghost"
          title="Quitar de la Oficina (vuelve si el bot hace algo nuevo)"
          onClick={() => act('dismiss', () => api.office.dismiss(d.key))}
        >
          ✕
        </button>
      </div>
      <div className="bubble">
        <div className="bubble-ticket">
          <span className="mono">{d.ticket}</span> {d.title}
        </div>
        <div className="bubble-text">
          {d.status === 'needs-you' && d.question ? d.question : d.bubble}
        </div>
      </div>
      {d.status === 'needs-you' && !d.capped && (
        <div className="desk-answer">
          <textarea
            placeholder="Tu respuesta: se publica en el ticket y el bot sigue con ella"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
          />
          <button
            className="primary"
            disabled={!answer.trim() || !!busy}
            onClick={() => act('answer', () => api.office.answer(d.key, answer.trim()))}
          >
            {busy === 'answer' ? 'Enviando…' : 'Responder'}
          </button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="desk-actions">
        {d.sessionUrl && (
          <button onClick={() => api.openExternal(d.sessionUrl!)}>Ver en vivo</button>
        )}
        <button className="ghost" onClick={() => api.openExternal(d.ticketUrl)}>
          Ticket
        </button>
        {d.pr && (
          <button className="ghost" onClick={() => api.openExternal(d.pr!.url)}>
            PR #{d.pr.number}
          </button>
        )}
        <span className="spacer" />
        {d.capped && (
          <button
            className="primary"
            disabled={!!busy}
            onClick={() => act('iterate', () => api.office.iterate(d.key))}
          >
            Iterar de todos modos
          </button>
        )}
        {d.status === 'idle' && (
          <button disabled={!!busy} onClick={() => act('retry', () => api.office.retry(d.key))}>
            Reintentar
          </button>
        )}
      </div>
    </div>
  )
}

export function Office({
  cfg,
  onConfig
}: {
  cfg: AppConfig
  onConfig: (c: AppConfig) => void
}): React.JSX.Element {
  const [desks, setDesks] = useState<Desk[] | null>(null)
  const [error, setError] = useState('')
  const [assigning, setAssigning] = useState(false)
  const [setup, setSetup] = useState(false)
  const [focused, setFocused] = useState('')
  const bots = cfg.bots ?? []

  const load = async (fresh = false): Promise<void> => {
    try {
      setDesks(await (fresh ? api.office.refresh() : api.office.desks()))
      setError('')
    } catch (e) {
      setError(errorText(e))
      setDesks([])
    }
  }

  useEffect(() => {
    void load()
    const offChanged = api.office.onChanged(setDesks)
    const offFocus = api.office.onFocus((key) => {
      setFocused(key)
      setTimeout(
        () => document.getElementById(`desk-${key}`)?.scrollIntoView({ block: 'center' }),
        100
      )
    })
    return () => {
      offChanged()
      offFocus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.bots])

  const count = (st: Desk['status']): number => (desks ?? []).filter((d) => d.status === st).length

  return (
    <div className="page">
      <div className="page-head">
        <h1>Oficina</h1>
        {desks && desks.length > 0 && (
          <span className="office-counts">
            <span className="desk-status needs-you">
              <span className="dot" /> {count('needs-you')}
            </span>
            <span className="desk-status working">
              <span className="dot" /> {count('working')}
            </span>
            <span className="desk-status done">
              <span className="dot" /> {count('done')}
            </span>
          </span>
        )}
        <span className="spacer" />
        <button
          className="ghost"
          onClick={() => void load(true)}
          title="Volver a leer Linear y GitHub"
        >
          ⟳
        </button>
        <button onClick={() => setSetup(true)}>⚙ Bots</button>
        <button className="primary" disabled={!bots.length} onClick={() => setAssigning(true)}>
          + Asignar ticket
        </button>
      </div>
      {error && <div className="error">{error}</div>}
      {!bots.length ? (
        <div className="empty">
          Aún no hay bots. Configura uno en <b>⚙ Bots</b>: una routine de Claude Code que trabaja
          tickets en la nube.
        </div>
      ) : desks === null ? (
        <div className="muted">Leyendo a los bots…</div>
      ) : desks.length === 0 ? (
        <div className="empty">
          Nadie trabaja ahora. Asígnale un ticket a un bot con <b>+ Asignar ticket</b>.
        </div>
      ) : (
        <div className="office">
          {desks.map((d) => (
            <DeskCard key={d.key} d={d} focused={focused === d.key} onDesks={setDesks} />
          ))}
        </div>
      )}
      {assigning && (
        <AssignDialog bots={bots} onClose={() => setAssigning(false)} onDone={setDesks} />
      )}
      {setup && <BotsDialog cfg={cfg} onClose={() => setSetup(false)} onSaved={onConfig} />}
    </div>
  )
}
