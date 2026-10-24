import { useEffect, useMemo, useState } from 'react'
import type {
  ApiCatalog,
  ApiEndpoint,
  ApiResponse,
  AppConfig,
  SessionInfo
} from '../../../shared/api'
import { api, errorText, useInterval } from '../api'
import { AgentTerminal } from './AgentTerminal'

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}

function bodyOf(e: ApiEndpoint): string {
  return e.body === undefined ? '' : JSON.stringify(e.body, null, 2)
}

/** Try a backend without a front: the endpoints the agent read from the code, one call at a time. */
export function ApiPane({
  cfg,
  session
}: {
  cfg: AppConfig
  session: SessionInfo
}): React.JSX.Element {
  // Backends first (no URL to open), the session's own before the ones Probar runs from trunk.
  const inSession = (name: string): boolean => session.repos.some((r) => r.name === name)
  const repos = cfg.repos
    .filter((r) => r.run?.port)
    .sort(
      (a, b) =>
        Number(!!a.run?.url) - Number(!!b.run?.url) ||
        Number(inSession(b.name)) - Number(inSession(a.name))
    )
    .map((r) => r.name)
  const [repo, setRepo] = useState(repos[0] ?? '')
  const [catalog, setCatalog] = useState<ApiCatalog | null>(null)
  const [catalogError, setCatalogError] = useState('')
  const [filter, setFilter] = useState('')
  const [picked, setPicked] = useState<number | null>(null)
  const [method, setMethod] = useState('GET')
  const [path, setPath] = useState('/')
  const [body, setBody] = useState('')
  const [userIndex, setUserIndex] = useState(0)
  const [auth, setAuth] = useState<{ name: string; value: string } | null>(null)
  const [response, setResponse] = useState<ApiResponse | null>(null)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [note, setNote] = useState('')
  const [filling, setFilling] = useState<string | null>(null)
  const [up, setUp] = useState<string[]>([])
  const users = cfg.testUsers ?? []

  const load = async (): Promise<void> => {
    if (!repo) return
    const r = await api.apiTest.catalog(session.id, repo)
    setCatalog(r.catalog)
    setCatalogError(r.error ?? '')
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repo, session.id])
  // While the agent writes the catalog, pick it up as soon as it lands.
  useInterval(load, filling || !catalog ? 3000 : null)
  // Which repos answer right now: a backend outside the session can be brought up from here.
  const loadUp = async (): Promise<void> =>
    setUp(await api.test.runningRepos(session.id).catch(() => []))
  useEffect(() => {
    void loadUp()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id, session.test])
  useInterval(loadUp, 3000)

  const endpoints = useMemo(() => {
    const q = filter.toLowerCase()
    return (catalog?.endpoints ?? [])
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => !q || `${e.method} ${e.path} ${e.summary ?? ''}`.toLowerCase().includes(q))
  }, [catalog, filter])

  const pick = (i: number): void => {
    const e = catalog!.endpoints[i]
    setPicked(i)
    setMethod(e.method)
    setPath(e.path)
    setBody(bodyOf(e))
    setResponse(null)
    setError('')
  }

  const request = (): {
    method: string
    path: string
    body: string
    headers?: Record<string, string>
  } => ({
    method,
    path,
    body,
    headers: auth ? { [auth.name]: auth.value } : undefined
  })

  const run = async (label: string, work: () => Promise<void>): Promise<void> => {
    setBusy(label)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
    }
  }

  const flash = (m: string): void => {
    setNote(m)
    setTimeout(() => setNote(''), 2500)
  }

  if (!repos.length)
    return (
      <div className="placeholder">Ningún repo del proyecto levanta un servidor con puerto.</div>
    )

  return (
    <div className="api-pane">
      <div className="api-bar">
        {repos.length > 1 && (
          <select
            value={repo}
            onChange={(e) => {
              // Another backend: its own endpoints and its own login.
              setRepo(e.target.value)
              setAuth(null)
              setPicked(null)
              setResponse(null)
            }}
          >
            {repos.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </select>
        )}
        <button
          title="El agente lee el código del repo y escribe todos sus endpoints con payloads de ejemplo"
          onClick={() =>
            run('fill', async () => setFilling(await api.apiTest.fill(session.id, repo)))
          }
        >
          ✨ {catalog ? 'Actualizar con el agente' : 'Llenar con el agente'}
        </button>
        <span className="spacer" />
        {catalog?.auth && users.length > 0 && (
          <>
            <select
              value={userIndex}
              onChange={(e) => setUserIndex(Number(e.target.value))}
              title="Usuario de prueba"
            >
              {users.map((u, i) => (
                <option key={u.email} value={i}>
                  {u.label ? `${u.label} · ${u.email}` : u.email}
                </option>
              ))}
            </select>
            <button
              className={auth ? 'ok-btn' : ''}
              disabled={!!busy}
              onClick={() =>
                run('login', async () => {
                  setAuth(await api.apiTest.login(session.id, repo, userIndex))
                  flash('Sesión iniciada: las llamadas llevan el token')
                })
              }
            >
              {busy === 'login' ? 'Entrando…' : auth ? '✓ Con sesión' : 'Iniciar sesión'}
            </button>
          </>
        )}
      </div>
      {note && <div className="api-note">{note}</div>}
      {repo && !up.includes(repo) && (
        <div className="api-down">
          <span>
            <b>{repo}</b> no está corriendo en esta sesión
            {inSession(repo) ? '.' : ' (se levanta desde main fresco, con su propio puerto).'}
          </span>
          <button
            className="primary"
            disabled={!!busy}
            onClick={() =>
              run('up', async () => {
                await api.test.startRepo(session.id, repo)
                await loadUp()
                flash(`${repo} está arriba`)
              })
            }
          >
            {busy === 'up' ? 'Levantando…' : `▶ Levantar ${repo}`}
          </button>
        </div>
      )}
      <div className="api-main">
        <div className="api-list">
          <input
            placeholder="Filtrar endpoints"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          {catalogError && <div className="error">{catalogError}</div>}
          {!catalog && !catalogError && (
            <div className="muted api-empty">
              Aún no hay endpoints. Dale «✨ Llenar con el agente» y los lee del código de esta
              rama.
            </div>
          )}
          {endpoints.map(({ e, i }) => (
            <div
              key={i}
              className={`api-endpoint ${picked === i ? 'on' : ''}`}
              onClick={() => pick(i)}
              title={e.summary}
            >
              <span className={`method m-${e.method.toLowerCase()}`}>{e.method}</span>
              <span className="api-path mono">{e.path}</span>
              {e.summary && <span className="api-summary">{e.summary}</span>}
            </div>
          ))}
        </div>
        <div className="api-editor">
          <div className="api-url">
            <select value={method} onChange={(e) => setMethod(e.target.value)}>
              {METHODS.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
            <input
              className="mono"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) =>
                e.key === 'Enter' &&
                run('send', async () =>
                  setResponse(await api.apiTest.send(session.id, repo, request()))
                )
              }
            />
            <button
              className="primary"
              disabled={!!busy}
              onClick={() =>
                run('send', async () =>
                  setResponse(await api.apiTest.send(session.id, repo, request()))
                )
              }
            >
              {busy === 'send' ? 'Enviando…' : 'Enviar'}
            </button>
            <button
              className="ghost"
              title="Copiar como curl"
              onClick={() =>
                run('curl', async () => {
                  await navigator.clipboard.writeText(
                    await api.apiTest.curl(session.id, repo, request())
                  )
                  flash('curl copiado al portapapeles')
                })
              }
            >
              curl
            </button>
          </div>
          {!['GET', 'HEAD'].includes(method) && (
            <textarea
              className="api-body mono"
              placeholder="Body JSON"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          )}
          {error && <div className="error">{error}</div>}
          {response && (
            <div className="api-response">
              <div className="api-status">
                <span
                  className={`code ${response.status < 300 ? 'ok' : response.status < 500 ? 'warn' : 'bad'}`}
                >
                  {response.status} {response.statusText}
                </span>
                <span className="muted">{response.ms} ms</span>
              </div>
              <pre className="mono">{pretty(response.body) || '(sin cuerpo)'}</pre>
            </div>
          )}
        </div>
      </div>
      {filling && (
        <div className="overlay">
          <div className="modal wide">
            <div className="row">
              <h2>Leyendo los endpoints de {repo}</h2>
              <span className="muted">
                La lista se carga sola cuando el agente escriba el catálogo.
              </span>
              <span className="spacer" />
              <button
                onClick={() => {
                  void api.pty.close(filling)
                  setFilling(null)
                  void load()
                }}
              >
                Cerrar
              </button>
            </div>
            <div className="term-box" style={{ flex: 1 }}>
              <AgentTerminal id={filling} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
