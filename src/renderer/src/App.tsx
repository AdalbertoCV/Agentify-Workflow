import logo from './logo.svg'
import { useCallback, useEffect, useState } from 'react'
import type { AppConfig, SessionInfo } from '../../shared/api'
import { api, errorText } from './api'
import { Board } from './screens/Board'
import { Connectors } from './screens/Connectors'
import { Repos } from './screens/Repos'
import { SessionView } from './screens/SessionView'

type Tab = 'sessions' | 'connectors' | 'repos'

function FirstRun({ onReady }: { onReady: (c: AppConfig) => void }): React.JSX.Element {
  const [error, setError] = useState('')
  return (
    <div className="placeholder" style={{ gap: 16 }}>
      <div className="brand" style={{ fontSize: 22 }}>
        <img src={logo} alt="" className="brand-logo" /> Agentify-Workflow
      </div>
      <div style={{ fontSize: 16, color: 'var(--text)' }}>
        Elige la carpeta donde viven tus repos
      </div>
      <div className="muted">
        Detecto los repos que hay ahí y preparo todo. Puedes cambiarla después.
      </div>
      <button
        className="primary"
        onClick={async () => {
          try {
            const c = await api.chooseRoot()
            if (c) onReady(c)
          } catch (e) {
            setError(errorText(e))
          }
        }}
      >
        Elegir carpeta
      </button>
      {error && <div className="error">{error}</div>}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [cfg, setCfg] = useState<AppConfig | null | undefined>(undefined)
  const [cfgError, setCfgError] = useState('')
  const [tab, setTab] = useState<Tab>('sessions')
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  const [openId, setOpenId] = useState<string | null>(null)
  const [failing, setFailing] = useState(0)
  const [activity, setActivity] = useState('')
  const [build, setBuild] = useState<{
    version: string
    commit?: string
    newer: string | null
  } | null>(null)

  useEffect(() => {
    api
      .getConfig()
      .then(setCfg)
      .catch((e) => {
        setCfgError(errorText(e))
        setCfg(null)
      })
  }, [])

  const refresh = useCallback(() => {
    api
      .listSessions()
      .then(setSessions)
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!cfg) return
    refresh()
    void api
      .connectors()
      .then((c) => setFailing(c.filter((x) => !x.ok).length))
      .catch(() => {})
    return api.onSessionsChanged(refresh)
  }, [cfg, refresh])

  // The main process keeps the code it started with: say so when a newer commit is on disk.
  useEffect(() => {
    const check = (): void =>
      void api
        .build()
        .then(setBuild)
        .catch(() => {})
    check()
    const t = setInterval(check, 60_000)
    return () => clearInterval(t)
  }, [])

  // Background work (base madre, creations) shows up in the top bar so something visibly happens.
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined
    const off = api.onProgress((m) => {
      setActivity(m)
      clearTimeout(t)
      t = setTimeout(() => setActivity(''), m.startsWith('✗') ? 60000 : 8000)
    })
    return () => {
      off()
      clearTimeout(t)
    }
  }, [])

  if (cfg === undefined) return <div className="placeholder">Cargando…</div>
  if (cfg === null)
    return (
      <div className="app">
        {cfgError && (
          <div className="error" style={{ padding: 16 }}>
            {cfgError}
          </div>
        )}
        <FirstRun onReady={setCfg} />
      </div>
    )

  const open = openId ? sessions.find((s) => s.id === openId) : undefined
  if (open)
    return (
      <div className="app">
        <SessionView cfg={cfg} session={open} onBack={() => setOpenId(null)} refresh={refresh} />
      </div>
    )

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">
          <img src={logo} alt="" className="brand-logo" /> Agentify-Workflow
        </div>
        <div className="tabs">
          <button
            className={`tab ${tab === 'sessions' ? 'active' : ''}`}
            onClick={() => setTab('sessions')}
          >
            Sesiones
          </button>
          <button
            className={`tab ${tab === 'connectors' ? 'active' : ''}`}
            onClick={() => setTab('connectors')}
          >
            Conectores{failing > 0 && <span className="badge" />}
          </button>
          <button
            className={`tab ${tab === 'repos' ? 'active' : ''}`}
            onClick={() => setTab('repos')}
          >
            Repos
          </button>
        </div>
        <span className="spacer" />
        {activity && (
          <span
            className={activity.startsWith('✗') ? 'error' : 'status'}
            title={activity}
            style={{
              maxWidth: 520,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap'
            }}
          >
            {!activity.startsWith('✗') && <span className="dot warn pulse" />} {activity}
          </span>
        )}
        {build && (
          <span
            className={build.newer ? 'warn-text mono' : 'muted mono'}
            title={
              build.newer
                ? `En disco ya está ${build.newer}; cierra la app y vuelve a abrirla para usarlo.`
                : 'Versión con la que arrancó la app'
            }
          >
            v{build.version}
            {build.commit ? ` · ${build.commit}` : ''}
            {build.newer ? ' · hay una versión más nueva: reinicia la app' : ''}
          </span>
        )}
        <span className="muted mono" title="Carpeta raíz">
          {cfg.root}
        </span>
        <button
          className="ghost"
          title="Cambiar carpeta"
          onClick={async () => {
            const c = await api.chooseRoot()
            if (c) setCfg(c)
          }}
        >
          Cambiar
        </button>
      </div>
      {tab === 'sessions' && (
        <Board
          cfg={cfg}
          sessions={sessions}
          refresh={refresh}
          onOpen={(id) => {
            refresh()
            setOpenId(id)
          }}
          onConnect={() => setTab('connectors')}
        />
      )}
      {tab === 'connectors' && <Connectors cfg={cfg} onChecked={setFailing} onConfig={setCfg} />}
      {tab === 'repos' && <Repos cfg={cfg} onSaved={setCfg} />}
    </div>
  )
}
