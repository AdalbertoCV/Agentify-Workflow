import { createServer, connect } from 'node:net'
import type { AppConfig } from './config'
import { readSessions } from './store'

const BASE = 20000
const BLOCK = 20

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', () => resolve(false))
    srv.listen(port, host, () => srv.close(() => resolve(true)))
  })
}

function answers(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ port, host })
    s.setTimeout(400)
    s.once('connect', () => {
      s.destroy()
      resolve(true)
    })
    s.once('timeout', () => {
      s.destroy()
      resolve(false)
    })
    s.once('error', () => resolve(false))
  })
}

/**
 * Free on every interface. Windows lets a second process bind a port that is already
 * taken (it silently gets no traffic), so a successful listen is not enough: also make
 * sure nothing answers on it.
 */
export async function isPortFree(port: number): Promise<boolean> {
  if (await answers(port, '127.0.0.1')) return false
  if (await answers(port, '::1')) return false
  return (await canListen(port, '127.0.0.1')) && (await canListen(port, '0.0.0.0'))
}

export async function portAnswers(port: number): Promise<boolean> {
  return (await answers(port, '127.0.0.1')) || (await answers(port, '::1'))
}

/** One port per repo with `run.port`, from the session's own block of 20. */
export async function allocatePorts(
  cfg: AppConfig,
  sessionId: string,
  used: Set<number>
): Promise<Record<string, number>> {
  const ids = readSessions(cfg.root).map((s) => s.id)
  let idx = ids.indexOf(sessionId)
  if (idx < 0) idx = ids.length
  let next = BASE + idx * BLOCK
  const out: Record<string, number> = {}
  for (const repo of cfg.repos) {
    if (!repo.run?.port) continue
    while (used.has(next) || !(await isPortFree(next))) next++
    out[repo.name] = next
    used.add(next)
    next++
  }
  return out
}

/** PIDs listening on `port` (any interface). */
export async function listenersOn(port: number): Promise<number[]> {
  const { run } = await import('./proc')
  if (process.platform === 'win32') {
    const { stdout } = await run('netstat', ['-ano'], { cwd: process.cwd() })
    const pids = new Set<number>()
    for (const line of stdout.split('\n')) {
      const cols = line.trim().split(/ +/)
      if (cols[0] !== 'TCP' || !/LISTEN/i.test(cols[3] ?? '')) continue
      if (cols[1].endsWith(`:${port}`)) pids.add(Number(cols[4]))
    }
    return [...pids].filter((p) => p > 0)
  }
  try {
    const { stdout } = await run('lsof', ['-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { cwd: process.cwd() })
    return stdout.split(/\s+/).filter(Boolean).map(Number)
  } catch {
    return []
  }
}
