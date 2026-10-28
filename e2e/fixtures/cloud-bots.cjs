// A stand-in Linear (GraphQL) and Claude Code routines fire API for the e2e. The "bot" behaves like a
// real one would: on a start it takes the ticket and asks a question; on an answer it delivers a PR.
const http = require('node:http')

function start() {
  const state = {
    labels: { 'label-bot': 'bot-demo' },
    issues: [
      { id: 'uuid-100', identifier: 'DEMO-100', title: 'Filtrar pedidos por estado', url: 'https://linear.app/demo/issue/DEMO-100', labels: [], comments: [], prUrls: [], state: 'Todo', type: 'unstarted', parent: 'DEMO-102' },
      { id: 'uuid-101', identifier: 'DEMO-101', title: 'Exportar pedidos a CSV', url: 'https://linear.app/demo/issue/DEMO-101', labels: [], comments: [], prUrls: [], state: 'Todo', type: 'unstarted', priority: 2, parent: 'DEMO-102' },
      { id: 'uuid-102', identifier: 'DEMO-102', title: 'Epic: pedidos para operación', url: 'https://linear.app/demo/issue/DEMO-102', labels: [], comments: [], prUrls: [], state: 'Backlog', type: 'backlog' },
      { id: 'uuid-103', identifier: 'DEMO-103', title: 'Totales por cliente', url: 'https://linear.app/demo/issue/DEMO-103', labels: [], comments: [], prUrls: [], state: 'In Progress', type: 'started', parent: 'DEMO-102', assignee: 'Otra persona' },
      { id: 'uuid-99', identifier: 'DEMO-99', title: 'Paginar la lista de pedidos', url: 'https://linear.app/demo/issue/DEMO-99', labels: [], comments: [], prUrls: [], state: 'Done', type: 'completed' }
    ],
    states: [
      { id: 'st-backlog', name: 'Backlog', type: 'backlog', position: 0, color: '#bec2c8' },
      { id: 'st-todo', name: 'Todo', type: 'unstarted', position: 1, color: '#e2e2e2' },
      { id: 'st-in-progress', name: 'In Progress', type: 'started', position: 2, color: '#f2c94c' },
      { id: 'st-in-review', name: 'In Review', type: 'started', position: 3, color: '#0f9d58' },
      { id: 'st-done', name: 'Done', type: 'completed', position: 4, color: '#5e6ad2' },
      { id: 'st-canceled', name: 'Canceled', type: 'canceled', position: 5, color: '#95a2b3' }
    ],
    fires: [],
    moves: []
  }
  const mine = (i) => !i.assignee
  const kids = (i) => state.issues.filter((k) => k.parent === i.identifier)
  const link = (i) => ({ identifier: i.identifier, title: i.title, state: { name: i.state, type: i.type } })
  const issue = (key) => state.issues.find((i) => i.id === key || i.identifier === key)
  const say = (i, body) => i.comments.push({ body, createdAt: new Date(Date.now() + i.comments.length).toISOString() })

  const server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      const json = (body) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (req.url === '/artifacts') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end('<!doctype html><title>Artifacts</title><body style="font-family:sans-serif;padding:24px"><h1>Tus artifacts</h1><ul><li>Plan de pedidos</li><li>Tablero de métricas</li></ul></body>')
      }
      const fire = /^\/routines\/([^/]+)\/fire$/.exec(req.url)
      if (fire) {
        const { text } = JSON.parse(raw || '{}')
        const ticket = /Ticket: (\S+)/.exec(text)?.[1]
        const i = issue(ticket)
        state.fires.push(text)
        if (i && /Respuesta del dueño/.test(text)) {
          i.prUrls.push('https://github.com/org/demo/pull/5')
          say(i, 'Bot Demo · entrega: https://github.com/org/demo/pull/5 con el filtro por estado.')
        } else if (i) {
          i.state = 'In Progress'
          i.type = 'started'
          say(i, 'Bot Demo · veredicto: lo tomo')
          say(i, 'Bot Demo · pregunta: ¿El filtro debe quedar en la URL (?status=) para poder compartirlo?')
        }
        const n = state.fires.length
        return json({ type: 'routine_fire', claude_code_session_id: `session_${n}`, claude_code_session_url: `https://claude.ai/code/session_${n}` })
      }
      const { query, variables = {} } = JSON.parse(raw || '{}')
      if (query.includes('viewer { name }')) return json({ data: { viewer: { name: 'Demo' } } })
      const card = (i) => ({ identifier: i.identifier, title: i.title, description: '', url: i.url, priority: i.priority ?? 0, updatedAt: '2026-10-01T00:00:00Z', team: { key: 'DEMO' }, labels: { nodes: i.labels.map((name) => ({ name })) }, state: { name: i.state, type: i.type }, inverseRelations: { nodes: [] }, parent: i.parent ? { identifier: i.parent } : null })
      if (query.includes('assignee { name }')) {
        const i = issue(variables.id)
        const parent = i.parent && issue(i.parent)
        return json({ data: { issue: { ...card(i), description: `Detalle de ${i.identifier}.`, assignee: { name: i.assignee ?? 'Demo' }, parent: parent ? link(parent) : null, children: { nodes: kids(i).map(link) } } } })
      }
      if (query.includes('issueUpdate')) {
        const i = issue(variables.id)
        const to = state.states.find((st) => st.id === variables.stateId)
        i.state = to.name
        i.type = to.type
        state.moves.push(`${i.identifier}→${to.name}`)
        return json({ data: { issueUpdate: { success: true } } })
      }
      if (query.includes('open: assignedIssues'))
        return json({
          data: {
            viewer: {
              teams: { nodes: [{ key: 'DEMO', states: { nodes: state.states } }] },
              open: { nodes: state.issues.filter((i) => mine(i) && i.type !== 'completed').map((i) => ({ ...card(i), children: { nodes: kids(i).map((k) => ({ state: { type: k.type } })) } })) },
              done: { nodes: state.issues.filter((i) => mine(i) && i.type === 'completed').map(card) }
            }
          }
        })
      if (query.includes('assignedIssues'))
        return json({
          data: {
            viewer: {
              assignedIssues: {
                nodes: state.issues.filter((i) => mine(i) && i.type !== 'completed').map((i) => ({ identifier: i.identifier, title: i.title, description: '', url: i.url, state: { name: i.state, type: i.type }, inverseRelations: { nodes: [] } }))
              }
            }
          }
        })
      if (query.includes('issueLabels'))
        return json({
          data: {
            issueLabels: { nodes: Object.entries(state.labels).filter(([, n]) => n === variables.label).map(([id]) => ({ id })) },
            issue: { id: issue(variables.issue).id }
          }
        })
      if (query.includes('issueAddLabel')) {
        issue(variables.id).labels.push(state.labels[variables.labelId])
        return json({ data: { issueAddLabel: { success: true } } })
      }
      if (query.includes('commentCreate')) {
        say(issue(variables.input.issueId), variables.input.body)
        return json({ data: { commentCreate: { success: true } } })
      }
      if (query.includes('issue(id: $id)')) return json({ data: { issue: { id: issue(variables.id).id } } })
      if (query.includes('issues(')) {
        const nodes = state.issues
          .filter((i) => i.labels.includes(variables.label))
          .map((i) => ({
            id: i.id,
            identifier: i.identifier,
            title: i.title,
            url: i.url,
            state: { name: i.state },
            comments: { nodes: i.comments },
            attachments: { nodes: i.prUrls.map((url) => ({ url })) }
          }))
        return json({ data: { issues: { nodes } } })
      }
      json({ errors: [{ message: `consulta no simulada: ${query.slice(0, 60)}` }] })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, state, port: server.address().port })))
}

module.exports = { start }
