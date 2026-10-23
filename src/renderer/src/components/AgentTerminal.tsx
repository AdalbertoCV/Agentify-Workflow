import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef } from 'react'
import { api } from '../api'

/** A live terminal bound to a pty in main. History is replayed, so remounting loses nothing. */
export function AgentTerminal({ id }: { id: string }): React.JSX.Element {
  const host = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const term = new Terminal({
      fontFamily: "'Cascadia Code', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      theme: { background: '#0b0d11', foreground: '#dfe3ea', cursor: '#ff8a3d', selectionBackground: '#33405a' }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current!)
    let disposed = false

    const offData = api.pty.onData((sid, d) => sid === id && term.write(d))
    const offExit = api.pty.onExit((sid, code) => {
      if (sid === id) term.write(`\r\n\x1b[90m[terminó con código ${code} — reabre la sesión para continuar]\x1b[0m\r\n`)
    })
    const input = term.onData((d) => api.pty.write(id, d))
    // Ctrl+V pastes text; Ctrl+C copies when there is a selection.
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true
      if (ev.ctrlKey && ev.key === 'c' && term.hasSelection()) {
        void navigator.clipboard.writeText(term.getSelection())
        return false
      }
      if (ev.ctrlKey && ev.key === 'v') {
        void navigator.clipboard.readText().then((t) => t && api.pty.write(id, t))
        return false
      }
      return true
    })

    const doFit = (): void => {
      if (disposed || !host.current?.offsetWidth) return
      try {
        fit.fit()
        api.pty.resize(id, term.cols, term.rows)
      } catch {
        // not laid out yet
      }
    }
    const ro = new ResizeObserver(doFit)
    ro.observe(host.current!)

    void (async () => {
      const history = await api.pty.history(id)
      if (disposed) return
      if (history) term.write(history)
      await api.pty.open(id)
      doFit()
      // Full-screen agents (Claude Code) only repaint on a size change: nudge one so the
      // conversation shows again when you come back to the session.
      if (term.cols > 2) {
        api.pty.resize(id, term.cols - 1, term.rows)
        setTimeout(() => !disposed && api.pty.resize(id, term.cols, term.rows), 80)
      }
      term.focus()
    })()

    return () => {
      disposed = true
      ro.disconnect()
      offData()
      offExit()
      input.dispose()
      term.dispose()
    }
  }, [id])

  return <div className="terminal" ref={host} />
}
