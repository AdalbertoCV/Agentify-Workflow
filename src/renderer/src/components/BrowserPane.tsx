import { useEffect, useRef, useState } from 'react'
import type { SessionInfo, TestUser } from '../../../shared/api'
import { api, errorText } from '../api'
import { TestUsersMenu } from './TestUsersMenu'

type WebviewEl = HTMLElement & {
  getWebContentsId(): number
  goBack(): void
  goForward(): void
  reload(): void
  loadURL(url: string): Promise<void>
  getURL(): string
  executeJavaScript(code: string): Promise<unknown>
}

type Rect = { x: number; y: number; width: number; height: number }

export function BrowserPane({
  session,
  testUsers = []
}: {
  session: SessionInfo
  testUsers?: TestUser[]
}): React.JSX.Element {
  const view = useRef<WebviewEl | null>(null)
  const [ready, setReady] = useState(false)
  const [address, setAddress] = useState(session.url ?? '')
  const [logs, setLogs] = useState('')
  const [error, setError] = useState('')
  const [selecting, setSelecting] = useState(false)
  const [box, setBox] = useState<Rect | null>(null)
  const [toast, setToast] = useState('')
  // Fills the app window with CSS only: the webview stays mounted, so the page is not reloaded.
  const [full, setFull] = useState(false)

  useEffect(() => {
    if (!full) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !selecting) setFull(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [full, selecting])
  const start = useRef<{ x: number; y: number } | null>(null)
  const logsEl = useRef<HTMLDivElement>(null)

  const running = session.test === 'running' && session.url
  const starting = session.test === 'starting'

  useEffect(() => {
    void api.test.logs(session.id).then(setLogs)
    return api.test.onLog((id, line) => {
      if (id === session.id) setLogs((l) => (l + line + '\n').slice(-60_000))
    })
  }, [session.id])

  useEffect(() => {
    logsEl.current?.scrollTo(0, logsEl.current.scrollHeight)
  }, [logs])

  useEffect(() => {
    if (session.url) setAddress(session.url)
  }, [session.url])

  const attach = (el: WebviewEl | null): void => {
    if (!el || view.current === el) return
    view.current = el
    setReady(false)
    el.addEventListener('dom-ready', () => setReady(true))
    el.addEventListener('did-navigate', (e) => setAddress((e as unknown as { url: string }).url))
    el.addEventListener('did-navigate-in-page', (e) => setAddress((e as unknown as { url: string }).url))
  }

  const flash = (msg: string): void => {
    setToast(msg)
    setTimeout(() => setToast(''), 1500)
  }

  const probar = async (): Promise<void> => {
    setError('')
    setLogs('')
    try {
      await api.test.start(session.id)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const captureFull = async (): Promise<void> => {
    if (!view.current) return
    try {
      await api.capture(view.current.getWebContentsId())
      flash('Copiado al portapapeles')
    } catch (e) {
      flash(errorText(e))
    }
  }

  const finishRegion = async (r: Rect): Promise<void> => {
    setSelecting(false)
    setBox(null)
    if (!view.current || r.width < 4 || r.height < 4) return
    try {
      await api.capture(view.current.getWebContentsId(), {
        x: Math.round(r.x),
        y: Math.round(r.y),
        width: Math.round(r.width),
        height: Math.round(r.height)
      })
      flash('Copiado al portapapeles')
    } catch (e) {
      flash(errorText(e))
    }
  }

  const rel = (e: React.MouseEvent): { x: number; y: number } => {
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect()
    return { x: e.clientX - b.left, y: e.clientY - b.top }
  }

  return (
    <div className={`pane${full ? ' browser-full' : ''}`}>
      <div className="pane-bar">
        <button className="ghost" title="Atrás" disabled={!ready} onClick={() => view.current?.goBack()}>
          ←
        </button>
        <button className="ghost" title="Adelante" disabled={!ready} onClick={() => view.current?.goForward()}>
          →
        </button>
        <button className="ghost" title="Recargar" disabled={!ready} onClick={() => view.current?.reload()}>
          ⟳
        </button>
        <input
          value={address}
          placeholder="Presiona ▶ Probar para levantar la app"
          onChange={(e) => setAddress(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && view.current) {
              const url = /^https?:\/\//.test(address) ? address : `http://${address}`
              void view.current.loadURL(url)
            }
          }}
        />
        <TestUsersMenu
          users={testUsers}
          canFill={ready}
          fill={(script) => view.current?.executeJavaScript(script) ?? Promise.resolve(false)}
          notify={flash}
        />
        <button title="Arrastra para capturar un área" disabled={!ready} onClick={() => setSelecting(true)}>
          ✂ Recortar
        </button>
        <button title="Captura la página completa" disabled={!ready} onClick={captureFull}>
          ⛶ Completa
        </button>
        <button
          className="ghost"
          title={full ? 'Volver a la sesión (Esc)' : 'Ver el navegador a pantalla completa (Esc para salir)'}
          onClick={() => setFull(!full)}
        >
          {full ? '⤡' : '⤢'}
        </button>
      </div>
      <div className="pane-body">
        {running ? (
          <>
            <webview
              ref={(el) => attach(el as WebviewEl | null)}
              src={session.url}
              partition={`persist:agentify-${session.id}`}
            />
            {selecting && (
              <div
                className="region"
                onMouseDown={(e) => {
                  start.current = rel(e)
                  setBox({ ...start.current, width: 0, height: 0 })
                }}
                onMouseMove={(e) => {
                  if (!start.current) return
                  const p = rel(e)
                  const s = start.current
                  setBox({ x: Math.min(s.x, p.x), y: Math.min(s.y, p.y), width: Math.abs(p.x - s.x), height: Math.abs(p.y - s.y) })
                }}
                onMouseUp={() => {
                  start.current = null
                  if (box) void finishRegion(box)
                }}
                onKeyDown={(e) => e.key === 'Escape' && setSelecting(false)}
                tabIndex={-1}
              >
                {box && (
                  <div className="region-box" style={{ left: box.x, top: box.y, width: box.width, height: box.height }} />
                )}
              </div>
            )}
            {toast && <div className="toast">{toast}</div>}
          </>
        ) : starting || logs || error ? (
          <div className="logs" ref={logsEl}>
            {starting && <div className="muted">Levantando el entorno de la sesión…{'\n\n'}</div>}
            {logs}
            {error && <div className="error">{'\n'}{error}</div>}
            {!starting && (
              <div style={{ marginTop: 12 }}>
                <button className="primary" onClick={probar}>
                  ▶ Probar otra vez
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="placeholder">
            <div>La app de esta sesión aún no está corriendo.</div>
            <button className="primary" onClick={probar}>
              ▶ Probar
            </button>
            <div className="muted" style={{ fontSize: 12 }}>
              Levanta cada repo en sus propios puertos (los del ticket en su rama, el resto en main fresco).
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
