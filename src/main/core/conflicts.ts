export type Chunk = { kind: 'text'; text: string } | { kind: 'conflict'; main: string; branch: string }
export type Choice = 'main' | 'branch' | 'both'

/**
 * Splits a file with conflict markers into plain text and conflicts. During a rebase the HEAD
 * side is main (plus what was already replayed) and the other side is the branch's commit.
 * Each line keeps its own ending, so CRLF files stay CRLF.
 */
export function parseConflicts(text: string): Chunk[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? []
  const chunks: Chunk[] = []
  let plain = ''
  let state: 'text' | 'main' | 'base' | 'branch' = 'text'
  let main = ''
  let branch = ''
  for (const line of lines) {
    const bare = line.replace(/\r?\n$/, '')
    if (state === 'text' && bare.startsWith('<<<<<<< ')) {
      if (plain) chunks.push({ kind: 'text', text: plain })
      plain = ''
      main = ''
      branch = ''
      state = 'main'
    } else if (state === 'main' && bare.startsWith('||||||| ')) state = 'base'
    else if ((state === 'main' || state === 'base') && bare === '=======') state = 'branch'
    else if (state === 'branch' && bare.startsWith('>>>>>>> ')) {
      chunks.push({ kind: 'conflict', main, branch })
      state = 'text'
    } else if (state === 'text') plain += line
    else if (state === 'main') main += line
    else if (state === 'branch') branch += line
  }
  // A block that never closes (or a line that only looks like a marker) would lose the rest.
  if (state !== 'text') throw new Error('No pude leer los marcadores de conflicto de este archivo; pídeselo al agente.')
  if (plain) chunks.push({ kind: 'text', text: plain })
  return chunks
}

/** The file with each conflict replaced by the chosen side; "both" puts main first. */
export function resolveConflicts(chunks: Chunk[], choices: Choice[]): string {
  const count = chunks.filter((c) => c.kind === 'conflict').length
  if (choices.length !== count || choices.some((c) => !['main', 'branch', 'both'].includes(c)))
    throw new Error('Falta elegir algún bloque, o el archivo cambió desde que elegiste; vuelve a elegir.')
  let i = 0
  return chunks
    .map((c) => {
      if (c.kind === 'text') return c.text
      const pick = choices[i++]
      return pick === 'main' ? c.main : pick === 'branch' ? c.branch : c.main + c.branch
    })
    .join('')
}
