import { useEffect, useState } from 'react'
import type { Choice, Chunk, ConflictFile, RebaseState } from '../../../shared/api'
import { api, errorText } from '../api'

const CHOICE_LABEL: Record<Choice, string> = {
  main: 'Usar main',
  branch: 'Usar mi rama',
  both: 'Usar ambos'
}

function ConflictFileView({
  id,
  repo,
  file,
  onResolved
}: {
  id: string
  repo: string
  file: ConflictFile
  onResolved: () => void
}): React.JSX.Element {
  const [chunks, setChunks] = useState<Chunk[] | null>(null)
  const [choices, setChoices] = useState<(Choice | undefined)[]>([])
  const [error, setError] = useState('')

  useEffect(() => {
    if (file.kind !== 'text') return
    void api.rebase.chunks(id, repo, file.path).then(setChunks, (e) => setError(errorText(e)))
  }, [id, repo, file.path, file.kind])

  const resolve = async (how: Parameters<typeof api.rebase.resolve>[3]): Promise<void> => {
    try {
      await api.rebase.resolve(id, repo, file.path, how)
      onResolved()
    } catch (e) {
      setError(errorText(e))
    }
  }

  const conflicts = (chunks ?? []).filter(
    (c): c is Extract<Chunk, { kind: 'conflict' }> => c.kind === 'conflict'
  )
  const ready = conflicts.length > 0 && conflicts.every((_, i) => choices[i])

  return (
    <div className="conflict-file">
      <div className="conflict-head">
        <span className="st del">!</span>
        <span className="path mono">{file.path}</span>
        <span className="spacer" />
        {file.kind === 'text' && (
          <button
            className="primary"
            disabled={!ready}
            onClick={() => resolve({ choices: choices as Choice[], conflicts: conflicts.length })}
          >
            Marcar resuelto
          </button>
        )}
      </div>
      {error && <div className="error">{error}</div>}
      {file.kind === 'deleted-by-main' || file.kind === 'deleted-by-branch' ? (
        <div className="row conflict-deleted">
          <span className="muted">
            {file.kind === 'deleted-by-main'
              ? 'main borró este archivo y tu rama lo cambió.'
              : 'Tu rama borró este archivo y main lo cambió.'}
          </span>
          <button onClick={() => resolve({ keep: true })}>Conservar archivo</button>
          <button onClick={() => resolve({ remove: true })}>Borrarlo</button>
        </div>
      ) : file.kind === 'other' ? (
        <div className="muted conflict-deleted">
          Este conflicto no se puede elegir por bloques; pídeselo al agente.
        </div>
      ) : (
        conflicts.map((c, i) => (
          <div key={i} className="conflict-block">
            <div className="conflict-sides">
              <div
                className={`side ${choices[i] === 'main' || choices[i] === 'both' ? 'picked' : ''}`}
              >
                <div className="side-label">main</div>
                <pre>{c.main || '(vacío)'}</pre>
              </div>
              <div
                className={`side ${choices[i] === 'branch' || choices[i] === 'both' ? 'picked' : ''}`}
              >
                <div className="side-label">tu rama</div>
                <pre>{c.branch || '(vacío)'}</pre>
              </div>
            </div>
            <div className="row">
              {(['main', 'branch', 'both'] as Choice[]).map((ch) => (
                <button
                  key={ch}
                  className={choices[i] === ch ? 'primary' : ''}
                  onClick={() => setChoices((cur) => Object.assign([...cur], { [i]: ch }))}
                >
                  {CHOICE_LABEL[ch]}
                </button>
              ))}
            </div>
          </div>
        ))
      )}
    </div>
  )
}

/** Shown instead of the diff while a repo is in the middle of a rebase. */
export function ConflictsPane({
  id,
  repo,
  state,
  onChanged
}: {
  id: string
  repo: string
  state: RebaseState
  onChanged: () => void
}): React.JSX.Element {
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [asked, setAsked] = useState<'' | 'sent' | 'typed'>('')

  const act = async (label: string, work: () => Promise<unknown>): Promise<void> => {
    setBusy(label)
    setError('')
    try {
      await work()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy('')
      onChanged()
    }
  }

  const count = state.conflicts.length
  return (
    <div className="conflicts">
      <div className="conflicts-head">
        <div>
          <b>Rebase en curso</b>
          {state.step && state.total ? ` · commit ${state.step} de ${state.total}` : ''}
          {state.subject ? `: ${state.subject}` : ''}
        </div>
        {count ? (
          <span className="status" style={{ color: 'var(--warn)' }}>
            <span className="dot warn pulse" /> {count} archivo{count > 1 ? 's' : ''} en conflicto
          </span>
        ) : (
          <span className="status ok-text">
            <span className="dot ok" /> Sin conflictos
          </span>
        )}
        <span className="spacer" />
        {count > 0 && (
          <button
            disabled={!!busy}
            title="Escribe en la terminal del agente qué archivos resolver"
            onClick={() =>
              act('agent', () => api.rebase.askAgent(id, repo).then((r) => setAsked(r.submitted ? 'sent' : 'typed')))
            }
          >
            {busy === 'agent' ? 'Enviando…' : asked === 'sent' ? 'Pedido al agente ✓' : 'Pedirle al agente'}
          </button>
        )}
        <button
          className="ghost danger"
          disabled={!!busy}
          onClick={() => act('abort', () => api.rebase.abort(id, repo))}
        >
          Cancelar rebase
        </button>
        <button
          className="primary"
          disabled={count > 0 || !!busy}
          onClick={() => act('continue', () => api.rebase.continue(id, repo))}
        >
          {busy === 'continue' ? 'Continuando…' : 'Continuar rebase'}
        </button>
      </div>
      {asked === 'typed' && (
        <div className="warn-text conflicts-note">
          Escribí el pedido en la terminal del agente; revísalo y presiona Enter ahí.
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <div className="conflicts-body">
        {state.conflicts.map((f) => (
          <ConflictFileView
            key={`${f.path}:${state.step}`}
            id={id}
            repo={repo}
            file={f}
            onResolved={onChanged}
          />
        ))}
        {count === 0 && (
          <div className="muted conflicts-done">
            Todo resuelto. Dale «Continuar rebase» para seguir con el siguiente commit.
          </div>
        )}
      </div>
    </div>
  )
}
