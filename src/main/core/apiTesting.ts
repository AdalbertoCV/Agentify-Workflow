import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { TestUser } from './config'

/** One endpoint of a backend, as the agent read it from the code. */
export type ApiEndpoint = { method: string; path: string; summary?: string; body?: unknown }

/** How to log in: the call to make ({email}/{password} are filled) and where the token is in its answer. */
export type ApiAuth = {
  login: { method: string; path: string; body: unknown }
  tokenPath: string
  header?: string
  prefix?: string
}

export type ApiCatalog = { auth?: ApiAuth; endpoints: ApiEndpoint[] }
export type ApiRequest = { method: string; path: string; headers?: Record<string, string>; body?: string }
export type ApiResponse = { status: number; statusText: string; ms: number; headers: Record<string, string>; body: string }

const TIMEOUT_MS = 30_000

/** The catalog lives in the session folder: endpoints follow the branch, not the repo's trunk. */
export function catalogFile(sessionDir: string, repo: string): string {
  return join(sessionDir, `api-${repo}.json`)
}

export function readCatalog(file: string): ApiCatalog | null {
  if (!existsSync(file)) return null
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(raw?.endpoints)) throw new Error(`${file}: "endpoints" tiene que ser una lista`)
  const endpoints: ApiEndpoint[] = raw.endpoints
    .filter((e: unknown): e is ApiEndpoint => typeof (e as ApiEndpoint)?.path === 'string')
    .map((e: ApiEndpoint) => ({ ...e, method: String(e.method ?? 'GET').toUpperCase() }))
  return raw.auth?.login?.path && typeof raw.auth.tokenPath === 'string' ? { auth: raw.auth, endpoints } : { endpoints }
}

/** Replaces the "{email}" and "{password}" strings of a payload with the test user's. */
export function fillCredentials(value: unknown, user: TestUser): unknown {
  if (value === '{email}') return user.email
  if (value === '{password}') return user.password
  if (Array.isArray(value)) return value.map((v) => fillCredentials(v, user))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillCredentials(v, user)]))
  return value
}

function url(port: number, path: string): string {
  return `http://127.0.0.1:${port}${path.startsWith('/') ? path : `/${path}`}`
}

/** Calls the session's backend from the main process (no CORS). Any HTTP status is a response. */
export async function sendRequest(port: number, req: ApiRequest, fetchFn: typeof fetch = fetch): Promise<ApiResponse> {
  const method = req.method.toUpperCase()
  const withBody = !['GET', 'HEAD'].includes(method) && req.body?.trim()
  const headers: Record<string, string> = { Accept: 'application/json', ...req.headers }
  if (withBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
    headers['Content-Type'] = 'application/json'
  const t = Date.now()
  const res = await fetchFn(url(port, req.path), {
    method,
    headers,
    body: withBody ? req.body : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const body = await res.text()
  return {
    status: res.status,
    statusText: res.statusText,
    ms: Date.now() - t,
    headers: Object.fromEntries(res.headers.entries()),
    body
  }
}

/** Logs the test user in and returns the header that authenticates the next calls. */
export async function login(
  port: number,
  auth: ApiAuth,
  user: TestUser,
  fetchFn: typeof fetch = fetch
): Promise<{ name: string; value: string }> {
  const r = await sendRequest(
    port,
    { method: auth.login.method, path: auth.login.path, body: JSON.stringify(fillCredentials(auth.login.body, user)) },
    fetchFn
  )
  if (r.status >= 400) throw new Error(`El login respondió ${r.status}: ${r.body.slice(0, 200)}`)
  let token: unknown
  try {
    token = auth.tokenPath.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], JSON.parse(r.body))
  } catch {
    token = undefined
  }
  if (typeof token !== 'string' || !token) throw new Error(`No encontré el token en "${auth.tokenPath}" de la respuesta del login`)
  return { name: auth.header ?? 'Authorization', value: `${auth.prefix ?? 'Bearer '}${token}` }
}

/** The same call as a curl line (single quotes escaped for sh). */
export function curlFor(port: number, req: ApiRequest): string {
  const q = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`
  const method = req.method.toUpperCase()
  const withBody = !['GET', 'HEAD'].includes(method) && req.body?.trim()
  const headers = { ...req.headers }
  if (withBody && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type'))
    headers['Content-Type'] = 'application/json'
  return [
    `curl -X ${method} ${q(url(port, req.path))}`,
    ...Object.entries(headers).map(([k, v]) => `-H ${q(`${k}: ${v}`)}`),
    ...(withBody ? [`--data ${q(req.body!)}`] : [])
  ].join(' ')
}

/** What the agent is asked to do: read the repo and write the catalog. One line for the terminal. */
export function apiFillPrompt(repo: string, worktree: string, file: string, users: TestUser[]): string {
  const who = users.length
    ? ` Los usuarios de prueba de la base son: ${users.map((u) => u.email).join(', ')}.`
    : ''
  return (
    `Lee el código del repo ${repo} en ${worktree} y lista TODOS sus endpoints HTTP (rutas, vistas, routers). ` +
    `Escribe el archivo ${file} con este JSON y nada más: ` +
    '{"auth": {"login": {"method": "POST", "path": "<ruta de login>", "body": {<campos, con "{email}" y "{password}" donde van las credenciales>}}, ' +
    '"tokenPath": "<ruta con puntos al token en la respuesta, por ejemplo access o data.token>", "prefix": "Bearer "}, ' +
    '"endpoints": [{"method": "GET", "path": "/ruta/exacta/", "summary": "qué hace, en español", "body": {<payload de ejemplo realista y válido según el serializer, sólo si lleva body>}}]}. ' +
    'Usa las rutas completas como las resuelve el servidor (con prefijos y barra final si la lleva) y valores de ejemplo que pasen la validación; ' +
    `si no hay login por token, omite "auth".${who} No cambies ningún otro archivo.`
  )
}
