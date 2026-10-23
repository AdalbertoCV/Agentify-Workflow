import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join } from 'node:path'

export class ProcError extends Error {
  constructor(
    public cmd: string,
    public code: number | null,
    public stderr: string
  ) {
    super(`${cmd} falló (código ${code}): ${stderr.trim().split('\n').slice(-5).join('\n')}`)
  }
}

export interface RunOptions {
  cwd: string
  env?: Record<string, string>
  input?: NodeJS.ReadableStream
}

export function run(
  cmd: string,
  args: string[],
  opts: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      windowsHide: true
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => (stdout += d))
    child.stderr.on('data', (d) => (stderr += d))
    if (opts.input) opts.input.pipe(child.stdin)
    else child.stdin.end()
    child.on('error', (e) => reject(new ProcError(cmd, null, e.message)))
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new ProcError([cmd, ...args].join(' '), code, stderr || stdout))
    })
  })
}

/** First `command` + executable extension found on PATH (`where` is unreliable for some names). */
function searchPath(command: string, pathVar: string): string | undefined {
  if (isAbsolute(command)) return existsSync(command) ? command : undefined
  for (const dir of pathVar.split(';').filter(Boolean)) {
    for (const ext of ['.exe', '.cmd', '.bat', '.com']) {
      const p = join(dir.replace(/^"|"$/g, ''), command + ext)
      if (existsSync(p)) return p
    }
  }
  return undefined
}

/** npm's `.cmd` shims just call a real exe next to them; running it directly avoids cmd.exe quoting. */
function unwrapNpmShim(cmdFile: string): string | undefined {
  try {
    const m = /"%dp0%\\([^"]+\.exe)"/i.exec(readFileSync(cmdFile, 'utf8'))
    const exe = m && join(dirname(cmdFile), m[1])
    return exe && existsSync(exe) ? exe : undefined
  } catch {
    return undefined
  }
}

/** Resolves a command to something Windows can start directly. */
export async function resolveCommand(
  command: string,
  args: string[],
  pathVar: string = process.env.PATH ?? process.env.Path ?? ''
): Promise<{ file: string; args: string[] }> {
  if (process.platform !== 'win32') return { file: command, args }
  const found = searchPath(command, pathVar)
  if (!found) throw new Error(`No encontré "${command}" en el PATH. Instálalo desde la pestaña Conectores.`)
  if (/\.(cmd|bat)$/i.test(found)) {
    const exe = unwrapNpmShim(found)
    if (exe) return { file: exe, args }
    return { file: process.env.ComSpec ?? 'cmd.exe', args: ['/d', '/s', '/c', found, ...args] }
  }
  return { file: found, args }
}

/** `run` for user-facing tools that may be `.cmd` shims on Windows (npm-installed CLIs). */
export async function runResolved(
  command: string,
  args: string[],
  opts: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  const r = await resolveCommand(command, args)
  return run(r.file, r.args, opts)
}

let bashPath: string | undefined

/**
 * Git for Windows' bash. Plain `bash` on a Windows PATH is often WSL's launcher
 * (System32\bash.exe), which would run scripts inside Linux instead of the repo.
 */
export async function gitBash(): Promise<string> {
  if (bashPath) return bashPath
  if (process.platform !== 'win32') return (bashPath = 'bash')
  const candidates: string[] = []
  try {
    const { stdout } = await run('where', ['git'], { cwd: process.cwd() })
    for (const git of stdout.split(/\r?\n/).filter(Boolean)) {
      const root = git.replace(/\\(cmd|bin|mingw64\\bin)\\git\.exe$/i, '')
      candidates.push(join(root, 'bin', 'bash.exe'))
    }
  } catch {
    // git not on PATH; fall through to the default install location
  }
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe')
  bashPath = candidates.find((c) => existsSync(c)) ?? 'bash'
  return bashPath
}

/** Runs a shell line with Git Bash (`bash -lc`). */
export async function runShell(
  line: string,
  opts: RunOptions
): Promise<{ stdout: string; stderr: string }> {
  return run(await gitBash(), ['-lc', line], {
    ...opts,
    env: { PYTHONUTF8: '1', ...opts.env }
  })
}

export type RunningProcess = { pid: number; name: string; cmd: string }

/** Kills a process and its children. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (!pid) return
  if (process.platform === 'win32') {
    await run('taskkill', ['/T', '/F', '/PID', String(pid)], { cwd: process.cwd() }).catch(() => {})
    return
  }
  try {
    process.kill(-pid, 'SIGTERM')
  } catch {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone
    }
  }
}

/**
 * Processes whose executable or command line points inside any of `paths`, excluding this app
 * and everything it started (those are stopped through their own owners).
 */
export async function processesUsing(paths: string[]): Promise<RunningProcess[]> {
  if (process.platform !== 'win32' || !paths.length) return []
  const norm = (p: string): string => p.replace(/\\/g, '/').toLowerCase().replace(/\/+$/, '')
  const targets = paths.map(norm)
  const { stdout } = await run(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,ExecutablePath | ConvertTo-Json -Compress'
    ],
    { cwd: process.cwd() }
  )
  type Row = { ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string | null; ExecutablePath: string | null }
  const rows: Row[] = [].concat(JSON.parse(stdout || '[]'))
  const children = new Map<number, number[]>()
  for (const r of rows) children.set(r.ParentProcessId, [...(children.get(r.ParentProcessId) ?? []), r.ProcessId])
  const ours = new Set<number>()
  const stack = [process.pid]
  while (stack.length) {
    const pid = stack.pop()!
    if (ours.has(pid)) continue
    ours.add(pid)
    stack.push(...(children.get(pid) ?? []))
  }
  return rows
    .filter((r) => !ours.has(r.ProcessId))
    .filter((r) => {
      const hay = norm(`${r.CommandLine ?? ''} ${r.ExecutablePath ?? ''}`)
      return targets.some((t) => hay.includes(t + '/') || hay.includes(t + '"') || hay.endsWith(t))
    })
    .map((r) => ({ pid: r.ProcessId, name: r.Name, cmd: (r.CommandLine ?? r.ExecutablePath ?? '').slice(0, 200) }))
}
