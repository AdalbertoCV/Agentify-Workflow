// End-to-end smoke: drives the built app (npm run build first) against throwaway repos.
// Usage: node e2e/smoke.mjs [screenshotDir]
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs'
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
  `node -e "require('http').createServer((q,s)=>{s.setHeader('content-type','text/html');s.end('<h1 style=font-family:sans-serif>Hola desde '+process.env.AGENTIFY_SESSION+'</h1><p id=api>…</p><script>fetch(\\'http://127.0.0.1:'+process.env.AGENTIFY_PORT_API+'/\\').then(r=>r.json()).then(j=>document.getElementById(\\'api\\').textContent=\\'API en puerto \\'+j.port)</script>')}).listen(process.env.AGENTIFY_PORT,'127.0.0.1')"\n`
)
writeFileSync(
  join(root, 'agentify.config.json'),
  JSON.stringify(
    {
      branchPrefix: 'e2e',
      defaultAgent: 'shell',
      browserRepo: 'web',
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

// AGENTIFY_EXE=dist/win-unpacked/agentify.exe runs the same flow against the packaged app.
const app = await electron.launch({
  ...(process.env.AGENTIFY_EXE ? { executablePath: resolve(process.env.AGENTIFY_EXE), args: [] } : { args: ['.'] }),
  cwd: resolve('.'),
  env: { ...process.env, AGENTIFY_USER_DATA: userData }
})
const page = await app.firstWindow()
const step = async (name) => {
  await page.waitForTimeout(400)
  await page.screenshot({ path: join(shots, `${name}.png`) })
  console.log('✓', name)
}

try {
  await page.getByRole('button', { name: '+ Nueva sesión' }).waitFor()
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

  await page.getByText('⛶ Completa').click()
  await page.getByText('Copiado al portapapeles').waitFor({ timeout: 10000 })
  const types = await app.evaluate(async ({ clipboard }) => (await clipboard.read()).flatMap((i) => i.types))
  if (!types.some((t) => t.includes('image'))) throw new Error(`portapapeles sin imagen: ${types}`)
  await step('05-captura-completa')

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

  await page.getByText('← Tablero').click()
  await page.locator('.card', { hasText: 'E2E-1' }).waitFor()
  await step('07-tablero-con-sesion')

  await page.locator('.card', { hasText: 'E2E-1' }).locator('button[title="Borrar sesión"]').click()
  await page.getByText('Aún no tienes sesiones').waitFor({ timeout: 60000 })
  if (existsSync(join(root, '.worktrees', 'e2e-1'))) throw new Error('la carpeta de la sesión sigue ahí')
  if (git(join(root, 'web'), 'branch', '--list', 'e2e/*')) throw new Error('la rama sigue ahí')
  await step('09-borrada')

  await page.getByRole('button', { name: 'Conectores' }).click()
  await page.locator('.item').first().waitFor({ timeout: 60000 })
  await step('10-conectores')
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
