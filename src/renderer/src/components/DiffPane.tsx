import { html as diffHtml, parse } from 'diff2html'
import type { DiffFile } from 'diff2html/lib/types'
import { useEffect, useMemo, useState } from 'react'
import type { CommitResult, RepoDiff, SessionInfo } from '../../../shared/api'
import { api, errorText, useInterval } from '../api'

type Layout = 'line-by-line' | 'side-by-side'

function fileName(f: DiffFile): string {
  const strip = (n: string): string => n.replace(/^[ab]\//, '')
  if (f.isRename && f.oldName !== f.newName) return `${strip(f.oldName)} → ${strip(f.newName)}`
  return strip(f.newName === '/dev/null' ? f.oldName : f.newName)
}

function status(f: DiffFile): { label: string; cls: string } {
  if (f.isNew || f.oldName === '/dev/null') return { label: 'A', cls: 'add' }
  if (f.isDeleted || f.newName === '/dev/null') return { label: 'D', cls: 'del' }
  if (f.isRename) return { label: 'R', cls: 'mod' }
  return { label: 'M', cls: 'mod' }
}

export function DiffPane({ session }: { session: SessionInfo }): React.JSX.Element {
  const [diffs, setDiffs] = useState<RepoDiff[]>([])
  const [active, setActive] = useState(0)
  const [error, setError] = useState('')
  const [layout, setLayout] = useState<Layout>('line-by-line')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const [message, setMessage] = useState(`${session.ticket} `)
  const [committing, setCommitting] = useState(false)
  const [results, setResults] = useState<CommitResult[] | null>(null)

  const load = async (): Promise<void> => {
    if (document.hidden) return
    try {
      setDiffs(await api.diff(session.id))
      setError('')
    } catch (e) {
      setError(errorText(e))
    }
  }

  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session.id])
  useInterval(load, 3000)

  const current = diffs[Math.min(active, Math.max(diffs.length - 1, 0))]
  const files = useMemo(() => (current?.patch ? parse(current.patch) : []), [current?.patch])
  const totals = useMemo(
    () =>
      diffs.map((d) =>
        parse(d.patch).reduce((t, f) => ({ add: t.add + f.addedLines, del: t.del + f.deletedLines }), { add: 0, del: 0 })
      ),
    [diffs]
  )

  // New files start open when the change is small, closed when it is big.
  const isOpen = (key: string): boolean => open[key] ?? files.length <= 4
  const setAll = (value: boolean): void =>
    setOpen((o) => ({ ...o, ...Object.fromEntries(files.map((f) => [`${current.repo}:${fileName(f)}`, value])) }))

  const commit = async (): Promise<void> => {
    setCommitting(true)
    setResults(null)
    try {
      setResults(await api.commit(session.id, message))
      void load()
    } catch (e) {
      setResults([{ repo: '—', committed: false, pushed: false, error: errorText(e) }])
    } finally {
      setCommitting(false)
    }
  }

  const changed = diffs.some((d) => d.files > 0 || d.unpushed > 0)
  const unpushed = diffs.reduce((n, d) => n + d.unpushed, 0)

  return (
    <div className="pane">
      <div className="pane-bar">
        <span className="label">Diff</span>
        <div className="diff-tabs">
          {diffs.map((d, i) => (
            <button key={d.repo} className={i === active ? '' : 'ghost'} onClick={() => setActive(i)}>
              {d.repo} <span className="plus">+{totals[i]?.add ?? 0}</span> <span className="minus">−{totals[i]?.del ?? 0}</span>
              {d.unpushed > 0 && <span className="chip" title="Commits que aún no están en origin">↑{d.unpushed}</span>}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button className="ghost" title="Expandir todo" onClick={() => setAll(true)}>
          ⊞
        </button>
        <button className="ghost" title="Colapsar todo" onClick={() => setAll(false)}>
          ⊟
        </button>
        <button
          className="ghost"
          title={layout === 'line-by-line' ? 'Ver lado a lado' : 'Ver unificado'}
          onClick={() => setLayout(layout === 'line-by-line' ? 'side-by-side' : 'line-by-line')}
        >
          {layout === 'line-by-line' ? '◫' : '☰'}
        </button>
        <button className="ghost" title="Actualizar" onClick={load}>
          ⟳
        </button>
      </div>
      <div className="commit-bar">
        <input
          value={message}
          placeholder="Mensaje del commit"
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && changed && !committing && commit()}
        />
        <button className="primary" disabled={committing || !changed} onClick={commit}>
          {committing ? 'Subiendo…' : files.length || diffs.some((d) => d.files > 0) ? 'Commit y push' : 'Push'}
        </button>
      </div>
      {results && (
        <div className="commit-results">
          {results.map((r) => (
            <div key={r.repo} className={r.error ? 'error' : 'muted'}>
              {r.repo}:{' '}
              {r.error ??
                (r.committed || r.pushed
                  ? `${r.committed ? 'commit' : ''}${r.committed && r.pushed ? ' + ' : ''}${r.pushed ? 'push' : ''} ✓ ${r.sha ?? ''}`
                  : 'nada que subir')}
            </div>
          ))}
          <button className="ghost" onClick={() => setResults(null)}>
            ✕
          </button>
        </div>
      )}
      <div className="pane-body">
        {error ? (
          <div className="placeholder error">{error}</div>
        ) : files.length ? (
          <div className="diff-body">
            {files.map((f) => {
              const key = `${current.repo}:${fileName(f)}`
              const st = status(f)
              return (
                <div key={key} className="diff-file">
                  <div className="diff-file-head" onClick={() => setOpen((o) => ({ ...o, [key]: !isOpen(key) }))}>
                    <span className="chev">{isOpen(key) ? '▾' : '▸'}</span>
                    <span className={`st ${st.cls}`}>{st.label}</span>
                    <span className="path mono">{fileName(f)}</span>
                    <span className="spacer" />
                    <span className="plus">+{f.addedLines}</span>
                    <span className="minus">−{f.deletedLines}</span>
                  </div>
                  {isOpen(key) && (
                    <div
                      dangerouslySetInnerHTML={{
                        __html: diffHtml([f], { drawFileList: false, outputFormat: layout, matching: 'lines' })
                      }}
                    />
                  )}
                </div>
              )
            })}
          </div>
        ) : (
          <div className="placeholder">
            {unpushed > 0
              ? `Todo commiteado. ${unpushed} commit${unpushed > 1 ? 's' : ''} sin subir: dale Commit y push.`
              : 'Sin cambios pendientes.'}
          </div>
        )}
      </div>
    </div>
  )
}
