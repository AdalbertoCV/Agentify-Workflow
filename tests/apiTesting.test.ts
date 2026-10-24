import { createServer, type Server } from 'node:http'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import {
  apiFillPrompt,
  catalogFile,
  curlFor,
  fillCredentials,
  login,
  readCatalog,
  sendRequest
} from '../src/main/core/apiTesting'
import { tempDir } from './helpers/git'

let server: Server
let port = 0
const seen: { method: string; url: string; auth?: string; body: string }[] = []

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body })
      if (req.url === '/api/login/') {
        const { email, password } = JSON.parse(body)
        if (email === 'admin@local.test' && password === 'pw') {
          res.writeHead(200, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ data: { access: 'tok-123' } }))
        }
        res.writeHead(401)
        return res.end('{"detail":"bad credentials"}')
      }
      res.writeHead(req.url === '/api/missing/' ? 404 : 200, { 'content-type': 'application/json', 'x-test': 'yes' })
      res.end(JSON.stringify({ method: req.method, url: req.url, got: body ? JSON.parse(body) : null }))
    })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as { port: number }).port
})
afterAll(() => server.close())

const auth = {
  login: { method: 'POST', path: '/api/login/', body: { email: '{email}', password: '{password}' } },
  tokenPath: 'data.access'
}
const admin = { label: 'Admin', email: 'admin@local.test', password: 'pw' }

test('sends a request to the session port and reports status, time, headers and body', async () => {
  const r = await sendRequest(port, { method: 'POST', path: '/api/items/?x=1', body: '{"name":"a"}' })
  expect(r.status).toBe(200)
  expect(r.ms).toBeGreaterThanOrEqual(0)
  expect(r.headers['x-test']).toBe('yes')
  expect(JSON.parse(r.body)).toEqual({ method: 'POST', url: '/api/items/?x=1', got: { name: 'a' } })
  expect(seen.at(-1)).toMatchObject({ method: 'POST' })
})

test('a 404 is a response, not an error; GET sends no body', async () => {
  const r = await sendRequest(port, { method: 'GET', path: '/api/missing/', body: '{"ignored":true}' })
  expect(r.status).toBe(404)
  expect(seen.at(-1)!.body).toBe('')
})

test('logging in fills the test user and returns the header for the next calls', async () => {
  const header = await login(port, auth, admin)
  expect(header).toEqual({ name: 'Authorization', value: 'Bearer tok-123' })
  expect(JSON.parse(seen.at(-1)!.body)).toEqual({ email: 'admin@local.test', password: 'pw' })
})

test('a failed login says what the API answered', async () => {
  await expect(login(port, auth, { email: 'x@y.z', password: 'no' })).rejects.toThrow(/401/)
})

test('credentials are filled anywhere in a payload, and only where asked', () => {
  expect(fillCredentials({ a: '{email}', b: ['{password}', 3], c: 'keep' }, admin)).toEqual({
    a: 'admin@local.test',
    b: ['pw', 3],
    c: 'keep'
  })
})

test('the catalog the agent writes is read and checked', () => {
  const dir = tempDir()
  const file = catalogFile(dir, 'api')
  expect(readCatalog(file)).toBeNull()
  writeFileSync(
    file,
    JSON.stringify({ auth, endpoints: [{ method: 'get', path: '/api/items/', summary: 'Lista' }] })
  )
  expect(readCatalog(file)).toEqual({
    auth,
    endpoints: [{ method: 'GET', path: '/api/items/', summary: 'Lista' }]
  })
  writeFileSync(file, '{"endpoints": "nope"}')
  expect(() => readCatalog(file)).toThrow(/endpoints/)
  expect(file).toBe(join(dir, 'api-api.json'))
})

test('copy as curl gives a command that repeats the call', () => {
  const c = curlFor(8000, {
    method: 'POST',
    path: '/api/items/',
    headers: { Authorization: 'Bearer t' },
    body: '{"name":"it\'s"}'
  })
  expect(c).toBe(
    `curl -X POST 'http://127.0.0.1:8000/api/items/' -H 'Authorization: Bearer t' -H 'Content-Type: application/json' --data '{"name":"it'\\''s"}'`
  )
})

test('the prompt tells the agent where to write the catalog, its shape and the test users', () => {
  const p = apiFillPrompt('api', 'C:/wt/api', 'C:/s/api-api.json', [admin])
  expect(p).toContain('C:/wt/api')
  expect(p).toContain('C:/s/api-api.json')
  expect(p).toContain('{email}')
  expect(p).toContain('admin@local.test')
  expect(p).not.toMatch(/\n/)
})
