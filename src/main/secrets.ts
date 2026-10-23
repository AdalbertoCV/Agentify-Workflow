import { app, safeStorage } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function file(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function readAll(): Record<string, string> {
  return existsSync(file()) ? JSON.parse(readFileSync(file(), 'utf8')) : {}
}

/** Secrets encrypted with the OS keychain (DPAPI on Windows); never written in clear text. */
export function getSecret(name: string): string | null {
  const v = readAll()[name]
  if (!v) return null
  try {
    return safeStorage.decryptString(Buffer.from(v, 'base64'))
  } catch {
    return null
  }
}

export function setSecret(name: string, value: string): void {
  const all = readAll()
  if (value) all[name] = safeStorage.encryptString(value).toString('base64')
  else delete all[name]
  writeFileSync(file(), JSON.stringify(all, null, 2))
}
