import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import type { AppConfig } from '../src/main/core/config'
import { allocatePorts, isPortFree } from '../src/main/core/ports'
import { Runner, resolveStack } from '../src/main/core/runner'
import type { Session } from '../src/main/core/store'
import { writeSessions } from '../src/main/core/store'
import { makeOriginAndClone, tempDir } from './helpers/git'

const SERVE = `node -e "require('http').createServer((q,s)=>s.end('ok')).listen(process.env.AGENTIFY_PORT,'127.0.0.1');console.log('up',process.env.AGENTIFY_PORT)"`

function setup(): { cfg: AppConfig; session: Session } {
  const root = tempDir()
  makeOriginAndClone(root, 'main', 'api')
  makeOriginAndClone(root, 'main', 'web')
  mkdirSync(join(root, 'scripts'))
  writeFileSync(join(root, 'scripts', 'serve.sh'), `${SERVE}\n`)
  writeFileSync(join(root, 'scripts', 'fail.sh'), 'echo boom; exit 1\n')
  const cfg: AppConfig = {
    root,
    branchPrefix: 'p',
    browserRepo: 'web',
    repos: [
      {
        name: 'api',
        path: join(root, 'api'),
        trunk: 'main',
        copyFiles: [],
        linkDirs: [],
        setup: [],
        run: { script: 'scripts/serve.sh', port: true }
      },
      {
        name: 'web',
        path: join(root, 'web'),
        trunk: 'main',
        copyFiles: [],
        linkDirs: [],
        setup: [],
        run: { script: 'scripts/serve.sh', port: true, needs: ['api'], url: 'http://localhost:{port}/' }
      }
    ],
    agents: [{ id: 'claude', label: 'Claude', command: 'claude', args: [], resumeArgs: [] }],
    defaultAgent: 'claude'
  }
  const session: Session = {
    id: 't-1',
    ticket: 'T-1',
    title: 'x',
    agent: 'claude',
    createdAt: '',
    imported: false,
    repos: [{ name: 'web', worktree: join(root, 'web'), branch: 'main', createdBranch: false }]
  }
  writeSessions(root, [session])
  return { cfg, session }
}

describe('ports', () => {
  test('skips a port that is already listening', async () => {
    const { cfg } = setup()
    const first = await allocatePorts(cfg, 't-1', new Set())
    const busy = createServer().listen(first.api, '127.0.0.1')
    await new Promise((r) => busy.once('listening', r))
    expect(await isPortFree(first.api)).toBe(false)
    const again = await allocatePorts(cfg, 't-1', new Set())
    expect(again.api).not.toBe(first.api)
    expect(Object.values(again)).not.toContain(first.api)
    busy.close()
  })
})

describe('runner', () => {
  test('extra repos join the stack with their needs, from trunk', () => {
    const { cfg, session } = setup()
    session.repos = [{ name: 'api', worktree: join(cfg.root, 'api'), branch: 'main', createdBranch: false }]
    expect(resolveStack(cfg, session).map((s) => s.repo.name)).toEqual(['api'])
    expect(resolveStack(cfg, session, ['web']).map((s) => [s.repo.name, s.fromSession])).toEqual([
      ['api', true],
      ['web', false]
    ])
  })

  test('stack puts needs first and takes missing repos from trunk', () => {
    const { cfg, session } = setup()
    expect(resolveStack(cfg, session).map((s) => [s.repo.name, s.fromSession])).toEqual([
      ['api', false],
      ['web', true]
    ])
  })

  test('starts the stack on private ports, returns the browser url and stops it', async () => {
    const { cfg, session } = setup()
    const runner = new Runner()
    const lines: string[] = []
    const { url } = await runner.start(cfg, session, (_repo, line) => lines.push(line))
    expect(runner.status('t-1')).toBe('running')
    const port = Number(/:(\d+)\//.exec(url!)![1])
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok')
    expect(lines.some((l) => l.includes('up'))).toBe(true)
    await runner.stop('t-1')
    expect(runner.status('t-1')).toBe('stopped')
    expect(await isPortFree(port)).toBe(true)
  })

  test('a repo outside the session can be brought up later, into the running session', async () => {
    const { cfg, session } = setup()
    session.repos = [{ name: 'api', worktree: join(cfg.root, 'api'), branch: 'main', createdBranch: false }]
    const runner = new Runner()
    await runner.start(cfg, session, () => {})
    expect(runner.runningRepos('t-1')).toEqual(['api'])
    await runner.startRepo(cfg, session, 'web', () => {})
    expect(runner.runningRepos('t-1')).toEqual(['api', 'web'])
    const port = runner.ports('t-1').web
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('ok')
    await runner.stop('t-1')
    expect(await isPortFree(port)).toBe(true)
  })

  test('bringing up a repo of a stopped session starts the session with it', async () => {
    const { cfg, session } = setup()
    session.repos = [{ name: 'api', worktree: join(cfg.root, 'api'), branch: 'main', createdBranch: false }]
    const runner = new Runner()
    await runner.startRepo(cfg, session, 'web', () => {})
    expect(runner.status('t-1')).toBe('running')
    expect(runner.runningRepos('t-1')).toEqual(['api', 'web'])
    await runner.stop('t-1')
  })

  test('stop also kills a server that outlived its parent process', async () => {
    const { cfg, session } = setup()
    // bash → node launcher (exits) → detached server: the server is no longer in bash's process tree.
    writeFileSync(
      join(cfg.root, 'scripts', 'orphan.sh'),
      `node -e "const {spawn}=require('child_process');spawn(process.execPath,['-e',\\"require('http').createServer((q,s)=>s.end('ok')).listen(process.env.AGENTIFY_PORT,'127.0.0.1')\\"],{detached:true,stdio:'ignore'}).unref()"\nsleep 600\n`
    )
    cfg.repos[0].run!.script = 'scripts/orphan.sh'
    session.repos = [{ name: 'api', worktree: join(cfg.root, 'api'), branch: 'main', createdBranch: false }]
    const runner = new Runner()
    await runner.start(cfg, session, () => {})
    const port = runner.ports('t-1').api
    await runner.stop('t-1')
    expect(await isPortFree(port)).toBe(true)
  })

  test('an empty linked dir stops Probar with a clear instruction', async () => {
    const { cfg, session } = setup()
    cfg.repos[1].linkDirs = ['node_modules']
    mkdirSync(join(cfg.root, 'web', 'node_modules'))
    const runner = new Runner()
    await expect(runner.start(cfg, session, () => {})).rejects.toThrow(/node_modules está vacío.*npm install|instálalo/)
  })

  test('a script that exits reports error with its output', async () => {
    const { cfg, session } = setup()
    cfg.repos[0].run!.script = 'scripts/fail.sh'
    const runner = new Runner()
    await expect(runner.start(cfg, session, () => {})).rejects.toThrow(/boom/)
    expect(runner.status('t-1')).toBe('error')
  })
})
