/* eslint-disable react/no-unknown-property -- partition and useragent are attributes of Electron's <webview> */
import { useEffect, useRef, useState } from 'react'
import { api } from '../api'

type WebviewEl = HTMLElement & {
  goBack(): void
  canGoBack(): boolean
  reload(): void
  loadURL(url: string): Promise<void>
  getURL(): string
}

// Google refuses to sign in inside apps that say so in their user agent; look like plain Chrome.
const USER_AGENT = navigator.userAgent.replace(/\s(Electron|agentify[\w-]*)\/\S+/gi, '')

/**
 * Your Claude Code artifacts, in claude.ai itself: there is no public API to list them. The login
 * lives in its own persistent partition, so you sign in once.
 */
export function Artifacts({ hidden }: { hidden: boolean }): React.JSX.Element {
  const view = useRef<WebviewEl | null>(null)
  const [home, setHome] = useState<string | null>(null)
  const [url, setUrl] = useState('')

  useEffect(() => {
    void api.artifactsUrl().then(setHome)
  }, [])

  const attach = (el: WebviewEl | null): void => {
    if (!el || view.current === el) return
    view.current = el
    const track = (): void => setUrl(el.getURL())
    el.addEventListener('did-navigate', track)
    el.addEventListener('did-navigate-in-page', track)
  }

  return (
    <div className="page artifacts" hidden={hidden}>
      <div className="page-head">
        <h1>Artifacts</h1>
        <span className="muted mono artifacts-url" title={url}>
          {url}
        </span>
        <span className="spacer" />
        <button className="ghost" title="Atrás" onClick={() => view.current?.goBack()}>
          ←
        </button>
        <button
          className="ghost"
          title="Volver a la lista de artifacts"
          onClick={() => home && void view.current?.loadURL(home)}
        >
          Inicio
        </button>
        <button className="ghost" title="Recargar" onClick={() => view.current?.reload()}>
          ⟳
        </button>
        <button
          className="ghost"
          title="Abrir esta página en tu navegador"
          onClick={() => void api.openExternal(url || home || '')}
        >
          Abrir en navegador ↗
        </button>
      </div>
      <div className="artifacts-view">
        {home && (
          <webview
            ref={(el) => attach(el as WebviewEl | null)}
            src={home}
            partition="persist:claude"
            useragent={USER_AGENT}
          />
        )}
      </div>
      <div className="muted">
        Si el acceso con Google no abre aquí, entra con tu correo: claude.ai te manda un código.
      </div>
    </div>
  )
}
