const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)\s*$/

export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of text.split(/\r?\n/)) {
    if (/^\s*#/.test(raw)) continue
    const m = LINE.exec(raw)
    if (!m) continue
    let value = m[2]
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted) value = quoted[2]
    else value = value.replace(/\s+#.*$/, '')
    out[m[1]] = value
  }
  return out
}

export function setEnvValue(text: string, key: string, value: string): string {
  const lines = text.split('\n')
  const i = lines.findIndex((l) => LINE.exec(l.replace(/\r$/, ''))?.[1] === key)
  if (i >= 0) {
    lines[i] = `${key}=${value}${lines[i].endsWith('\r') ? '\r' : ''}`
    return lines.join('\n')
  }
  const base = text === '' || text.endsWith('\n') ? text : `${text}\n`
  return `${base}${key}=${value}\n`
}
