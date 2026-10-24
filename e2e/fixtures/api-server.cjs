// A tiny JSON API for the e2e: token login, an authenticated list/create, and CORS for the web page.
const http = require('node:http')

const items = [{ id: 1, name: 'Primera' }]
http
  .createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const send = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/api/login/' && req.method === 'POST') {
        const { email, password } = JSON.parse(raw || '{}')
        if (email === 'admin@local.test' && password === 'demo-pass') return send(200, { access: 'e2e-token' })
        return send(401, { detail: 'Credenciales inválidas' })
      }
      if (req.url.startsWith('/api/items/')) {
        if (req.headers.authorization !== 'Bearer e2e-token') return send(401, { detail: 'Falta el token' })
        if (req.method === 'POST') {
          const item = { id: items.length + 1, ...JSON.parse(raw || '{}') }
          items.push(item)
          return send(201, item)
        }
        return send(200, items)
      }
      send(200, { ok: true, port: process.env.AGENTIFY_PORT })
    })
  })
  .listen(process.env.AGENTIFY_PORT, '127.0.0.1')
