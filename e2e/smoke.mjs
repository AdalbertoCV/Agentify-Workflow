// End-to-end smoke: drives the built app (npm run build first) against throwaway repos.
// Usage: node e2e/smoke.mjs [screenshotDir]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

const shots = resolve(process.argv[2] ?? join(tmpdir(), 'agentify-shots'))
mkdirSync(shots, { recursive: true })
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

const root = mkdtempSync(join(tmpdir(), 'agentify-e2e-'))
for (const name of ['api', 'web']) {
  const seed = join(root, `${name}-seed`)
  mkdirSync(seed)
  git(seed, 'init', '-q', '-b', 'main')
  git(seed, 'config', 'user.email', 't@t')
  git(seed, 'config', 'user.name', 't')
  writeFileSync(join(seed, 'README.md'), `# ${name}\n`)
  writeFileSync(join(seed, '.gitignore'), 'node_modules\n.env\n')
  git(seed, 'add', '.')
  git(seed, 'commit', '-qm', 'init')
  git(root, 'init', '-q', '--bare', '-b', 'main', join(root, `${name}.git`))
  git(seed, 'push', '-q', join(root, `${name}.git`), 'main')
  git(root, 'clone', '-q', join(root, `${name}.git`), join(root, name))
}
mkdirSync(join(root, 'scripts'))
writeFileSync(
  join(root, 'scripts', 'api.sh'),
  `node -e "require('http').createServer((q,s)=>{s.setHeader('access-control-allow-origin','*');s.end(JSON.stringify({ok:true,port:process.env.AGENTIFY_PORT}))}).listen(process.env.AGENTIFY_PORT,'127.0.0.1')"\n`
)
writeFileSync(
  join(root, 'scripts', 'web.sh'),
  `node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1 style=font-family:sans-serif>Hola desde '+process.env.AGENTIFY_SESSION+'</h1><p id=api>…</p><form><input id=email type=email placeholder=email><input id=pw type=password></form><script>fetch(\\'http://127.0.0.1:'+process.env.AGENTIFY_PORT_API+'/\\').then(r=>r.json()).then(j=>document.getElementById(\\'api\\').textContent=\\'API en puerto \\'+j.port)</script>')}).listen(process.env.AGENTIFY_PORT,'127.0.0.1')"\n`
)
writeFileSync(
  join(root, 'agentify.config.json'),
  JSON.stringify(
    {
      branchPrefix: 'e2e',
      defaultAgent: 'shell',
      browserRepo: 'web',
      testUsers: [{ label: 'Admin', email: 'admin@local.test', password: 'demo-pass' }],
      agents: [{ id: 'shell', label: 'Shell', command: 'cmd', args: [], resumeArgs: [], waiting: 'idle' }],
      repos: [
        { name: 'api', path: 'api', trunk: 'main', run: { script: 'scripts/api.sh', port: true } },
        {
          name: 'web',
          path: 'web',
          trunk: 'main',
          run: { script: 'scripts/web.sh', port: true, needs: ['api'], url: 'http://localhost:{port}/' }
        }
      ]
    },
    null,
    2
  )
)
const userData = mkdtempSync(join(tmpdir(), 'agentify-ud-'))
writeFileSync(join(userData, 'settings.json'), JSON.stringify({ root }))

// A stand-in gh: logged in, and four open issues in org/issues, one of each status.
const fakeBin = join(root, 'fake-bin')
mkdirSync(fakeBin)
const issue = (number, title, labels = [], blockedBy = []) => ({
  number,
  title,
  body: '',
  url: `https://github.com/org/issues/issues/${number}`,
  labels: { nodes: labels.map((name) => ({ name })) },
  blockedBy: { nodes: blockedBy.map((n) => ({ number: n, state: 'OPEN', repository: { nameWithOwner: 'org/issues' } })) }
})
const fakeIssues = [
  issue(4, 'Bloqueado por otro', [], [1]),
  issue(3, 'Ya en revisión', ['in review']),
  issue(2, 'Alguien lo trabaja', ['in progress']),
  issue(1, 'Listo para empezar')
]
writeFileSync(
  join(fakeBin, 'gh-fake.cjs'),
  `const a = process.argv.slice(2)
if (a[0] === 'auth') { console.error('Logged in to github.com account e2e\\n  - Active account: true'); process.exit(0) }
if (a[0] === 'api' && a[1] === 'user') { console.log('e2e'); process.exit(0) }
if (a[0] === 'api' && a[1] === 'graphql') { console.log(JSON.stringify({ data: { repository: { issues: { nodes: ${JSON.stringify(fakeIssues)} } } } })); process.exit(0) }
console.error('gh falso: ' + a.join(' ')); process.exit(1)
`
)
writeFileSync(join(fakeBin, 'gh.cmd'), `@node "%~dp0gh-fake.cjs" %*\r\n`)

// AGENTIFY_EXE=dist/win-unpacked/agentify.exe runs the same flow against the packaged app.
const app = await electron.launch({
  ...(process.env.AGENTIFY_EXE ? { executablePath: resolve(process.env.AGENTIFY_EXE), args: [] } : { args: ['.'] }),
  cwd: resolve('.'),
  env: { ...process.env, AGENTIFY_USER_DATA: userData, PATH: `${fakeBin};${process.env.PATH}` }
})
const page = await app.firstWindow()
const step = async (name) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shots, `${name}.png`) })
  console.log('✓', name)
}

try {
  await page.getByRole('button', { name: '+ Nueva sesión' }).waitFor()
  // From source the bar shows the commit; an installed app has no checkout, only the version.
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'))
  const build = process.env.AGENTIFY_EXE ? `v${version}` : `· ${git(resolve('.'), 'rev-parse', '--short', 'HEAD')}`
  await page.getByText(build).waitFor({ timeout: 10000 })
  await step('01-tablero-vacio')

  await page.getByRole('button', { name: '+ Nueva sesión' }).click()
  await page.getByPlaceholder('ENG-123').fill('E2E-1')
  await page.locator('.modal input').nth(1).fill('Probar el flujo completo')
  await page.locator('.check', { hasText: 'web' }).click()
  await step('02-nueva-sesion')
  await page.getByRole('button', { name: 'Crear sesión' }).click()
  await page.getByText('← Tablero').waitFor({ timeout: 60000 })
  await page.locator('.xterm').waitFor()
  await page.waitForTimeout(1500)
  await page.locator('.xterm').click()
  await page.keyboard.type('echo hola desde la terminal\r')
  await step('03-sesion-abierta')

  await page.locator('.session-bar').getByText('▶ Probar').click()
  const webview = page.locator('webview')
  await webview.waitFor({ timeout: 90000 })
  await page.waitForTimeout(2500)
  await step('04-probar-navegador')

  await page.locator('button[title^="Ver el navegador a pantalla completa"]').click()
  const big = await page.locator('.pane.browser-full').boundingBox()
  const win = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })))
  if (!big || big.width < win.width - 2 || big.height < win.height - 2) throw new Error(`no ocupa la ventana: ${JSON.stringify(big)}`)
  const still = await page.evaluate(() => document.querySelector('webview').executeJavaScript('document.body.innerText'))
  if (!still.includes('Hola desde')) throw new Error('la página se recargó o se perdió al ampliar')
  await step('04b-navegador-pantalla-completa')
  await page.keyboard.press('Escape')
  await page.locator('.pane.browser-full').waitFor({ state: 'detached', timeout: 5000 })

  await page.getByText('⛶ Completa').click()
  await page.getByText('Copiado al portapapeles').waitFor({ timeout: 10000 })
  const types = await app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((i) => i.types))
  if (!types.some((t) => t.includes('image'))) throw new Error(`portapapeles sin imagen: ${types}`)
  await step('05-captura-completa')

  await page.getByRole('button', { name: '👤 Usuarios' }).click()
  await page.locator('.user-row', { hasText: 'admin@local.test' }).getByRole('button', { name: 'Llenar' }).click()
  await page.getByText('Login llenado con admin@local.test').waitFor({ timeout: 10000 })
  const filled = await page.evaluate(() =>
    document.querySelector('webview').executeJavaScript("[document.getElementById('email').value, document.getElementById('pw').value]")
  )
  if (filled[0] !== 'admin@local.test' || filled[1] !== 'demo-pass') throw new Error(`login no llenado: ${filled}`)
  await step('05b-usuarios-login-llenado')

  await page.getByText('✂ Recortar').click()
  const box = await page.locator('.region').boundingBox()
  await page.mouse.move(box.x + 20, box.y + 20)
  await page.mouse.down()
  await page.mouse.move(box.x + 300, box.y + 120, { steps: 5 })
  await page.mouse.up()
  await page.getByText('Copiado al portapapeles').waitFor({ timeout: 10000 })
  console.log('✓ recorte copiado')

  const wt = join(root, '.worktrees', 'e2e-1', 'web')
  writeFileSync(join(wt, 'README.md'), '# web\n\ncambio de la sesión\n')
  writeFileSync(join(wt, 'nuevo.txt'), 'archivo nuevo\n')
  await page.locator('.diff-file-head', { hasText: 'README.md' }).waitFor({ timeout: 15000 })
  await page.locator('.diff-file-head', { hasText: 'nuevo.txt' }).waitFor({ timeout: 15000 })
  await step('06-diff')
  await page.locator('.diff-file-head', { hasText: 'README.md' }).click()
  await page.locator('button[title="Ver lado a lado"]').click()
  await step('06b-diff-colapsado-lado-a-lado')
  await page.locator('.commit-bar input').fill('E2E-1 cambio de prueba')
  await page.getByRole('button', { name: 'Commit y push' }).click()
  await page.getByText('commit + push ✓').waitFor({ timeout: 30000 })
  const pushed = git(join(root, 'web.git'), 'log', '-1', '--format=%s', 'e2e/e2e-1-probar-el-flujo-completo')
  if (pushed !== 'E2E-1 cambio de prueba') throw new Error(`push no llegó: ${pushed}`)
  await step('06c-commit-push')

  // main changes the same line: updating the session brings a conflict to resolve in the app.
  const other = join(root, 'web-other')
  git(root, 'clone', '-q', join(root, 'web.git'), other)
  git(other, 'config', 'user.email', 't@t')
  git(other, 'config', 'user.name', 't')
  writeFileSync(join(other, 'README.md'), '# web\n\ncambio en main\n')
  git(other, 'commit', '-qam', 'main: readme')
  git(other, 'push', '-q', 'origin', 'main')
  await page.getByRole('button', { name: /Actualizar con main/ }).click()
  await page.getByText('hay conflictos; resuélvelos en el panel Diff').waitFor({ timeout: 30000 })
  await page.getByText('1 archivo en conflicto').waitFor({ timeout: 10000 })
  await page.locator('.conflict-sides').first().waitFor()
  await step('06d-conflicto')
  await page.getByRole('button', { name: 'Pedirle al agente' }).click()
  await page.getByText('revísalo y presiona Enter').waitFor({ timeout: 30000 })
  const typed = await page.evaluate(() => window.agentify.pty.history('e2e-1'))
  if (!typed.includes('Hay un rebase en curso')) throw new Error('el pedido no llegó a la terminal')
  if (typed.includes('no se reconoce como un comando')) throw new Error('se envió Enter a un agente que ya estaba abierto')
  await page.getByRole('button', { name: 'Usar ambos' }).click()
  await page.getByRole('button', { name: 'Marcar resuelto' }).click()
  await page.getByText('Sin conflictos').waitFor({ timeout: 10000 })
  await step('06e-sin-conflictos')
  await page.getByRole('button', { name: 'Continuar rebase' }).click()
  await page.locator('.conflicts').waitFor({ state: 'detached', timeout: 30000 })
  const merged = readFileSync(join(wt, 'README.md'), 'utf8').replace(/\r/g, '')
  if (merged !== '# web\n\ncambio en main\ncambio de la sesión\n')
    throw new Error(`resolución inesperada: ${JSON.stringify(merged)}`)
  await page.getByRole('button', { name: 'Push' }).click()
  await page.getByText('push forzado (--force-with-lease)').waitFor({ timeout: 30000 })
  await step('06f-push-tras-rebase')

  await page.getByText('← Tablero').click()
  await page.locator('.card', { hasText: 'E2E-1' }).waitFor()
  await step('07-tablero-con-sesion')

  await page.locator('.card', { hasText: 'E2E-1' }).locator('button[title="Borrar sesión"]').click()
  await page.getByText('Borrar E2E-1').waitFor()
  await page.locator('.del-step', { hasText: 'web: quitar worktree' }).waitFor()
  await step('08-borrar-confirmar')
  await page.locator('.modal').getByRole('button', { name: 'Borrar', exact: true }).click()
  await page.getByText('Sesión borrada').waitFor({ timeout: 60000 })
  if ((await page.locator('.del-step.done').count()) !== (await page.locator('.del-step').count()))
    throw new Error('quedaron pasos sin terminar')
  await step('08b-borrar-pasos-hechos')
  await page.getByText('Aún no tienes sesiones').waitFor({ timeout: 10000 })
  if (existsSync(join(root, '.worktrees', 'e2e-1'))) throw new Error('la carpeta de la sesión sigue ahí')
  if (git(join(root, 'web'), 'branch', '--list', 'e2e/*')) throw new Error('la rama sigue ahí')
  await step('09-borrada')

  await page.getByRole('button', { name: 'Conectores' }).click()
  await page.locator('.item').first().waitFor({ timeout: 60000 })
  await step('10-conectores')
  await page.locator('.seg').getByRole('button', { name: 'GitHub Issues' }).click()
  await page.getByPlaceholder('otro repo: dueño/repo').fill('org/issues')
  await page.getByRole('button', { name: 'Agregar' }).click()
  await page.locator('.gh-repos .chip', { hasText: 'org/issues' }).waitFor({ timeout: 30000 })
  await page.locator('.item', { hasText: 'GitHub Issues' }).waitFor({ timeout: 60000 })
  await step('10b-conectores-github')
  const saved = JSON.parse(readFileSync(join(root, 'agentify.config.json'), 'utf8')).tickets
  if (saved?.provider !== 'github' || saved.githubRepos?.[0] !== 'org/issues') throw new Error(`tickets no guardado: ${JSON.stringify(saved)}`)

  // Picking a ticket: only the ready one can start a session, and the blocked one says by which.
  await page.getByRole('button', { name: 'Sesiones' }).click()
  await page.getByRole('button', { name: '+ Nueva sesión' }).click()
  await page.locator('.issue').nth(3).waitFor({ timeout: 30000 })
  const rows = await page.locator('.issue').evaluateAll((els) => els.map((e) => [e.className, e.textContent]))
  if (!rows[0][0].includes('status-ready') || rows[0][0].includes('disabled')) throw new Error(`el elegible no va primero: ${rows[0]}`)
  if (rows.slice(1).some(([cls]) => !cls.includes('disabled'))) throw new Error('hay un ticket no elegible que se puede elegir')
  const blocked = rows.find(([cls]) => cls.includes('status-blocked'))
  if (!blocked?.[1].includes('Bloqueado por org/issues#1')) throw new Error(`no dice por cuál está bloqueado: ${blocked}`)
  await page.locator('.issue.status-blocked').click()
  if (await page.getByPlaceholder('ENG-123').inputValue()) throw new Error('un ticket bloqueado se pudo elegir')
  await page.locator('.issue.status-ready').click()
  if ((await page.getByPlaceholder('ENG-123').inputValue()) !== 'org/issues#1') throw new Error('el ticket listo no se eligió')
  await step('10b2-tickets-por-estado')
  await page.locator('.modal').getByRole('button', { name: 'Cancelar' }).click()
  await page.getByRole('button', { name: 'Conectores' }).click()
  await page.locator('.seg').getByRole('button', { name: 'Manual' }).click()
  await page.getByText('Escribes el ticket').waitFor()
  await step('10c-conectores-manual')

  await page.getByRole('button', { name: 'Sesiones' }).click()
  await page.getByRole('button', { name: '+ Nuevo ticket' }).click()
  await page.getByText('Con tickets manuales no hay dónde crearlos').waitFor()
  if (!(await page.getByRole('button', { name: 'Crear con el agente' }).isDisabled()))
    throw new Error('con Manual se puede crear un ticket')
  await step('10d-ticket-manual')
  await page.getByRole('button', { name: 'Conectores →' }).click()
  await page.locator('.seg').getByRole('button', { name: 'GitHub Issues' }).click()
  await page.locator('.ticket-prompt').fill('/mi-equipo:ticket {context}')
  await page.locator('.gh-repos', { has: page.locator('.ticket-prompt') }).getByRole('button', { name: 'Guardar' }).click()
  await page.waitForTimeout(500)
  const prompt = JSON.parse(readFileSync(join(root, 'agentify.config.json'), 'utf8')).ticketPrompt
  if (prompt !== '/mi-equipo:ticket {context}') throw new Error(`ticketPrompt no guardado: ${prompt}`)
  await page.getByRole('button', { name: 'Sesiones' }).click()
  await page.getByRole('button', { name: '+ Nuevo ticket' }).click()
  await page.locator('.modal select').waitFor()
  await page.locator('.ticket-context').fill('El detalle de la RFQ\ntruena al abrirlo')
  await step('10e-ticket-github')
  await page.getByRole('button', { name: 'Crear con el agente' }).click()
  await page.getByText('Creando ticket en GitHub Issues').waitFor({ timeout: 15000 })
  await page.locator('.modal .xterm').waitFor({ timeout: 15000 })
  await step('10f-ticket-agente')
  await page.locator('.modal').getByRole('button', { name: 'Cerrar' }).click()

  await page.getByRole('button', { name: 'Repos' }).click()
  await step('11-repos')
  console.log(`\nTodo bien. Capturas en ${shots}`)
} catch (e) {
  await page.screenshot({ path: join(shots, 'error.png') }).catch(() => {})
  console.error('✗', e.message)
  process.exitCode = 1
} finally {
  await app.close()
}
