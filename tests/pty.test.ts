import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { PtyManager } from '../src/main/pty'
import { tempDir } from './helpers/git'

function waitExit(m: PtyManager, id: string): Promise<number> {
  return new Promise((resolve) => m.onExit((sid, code) => sid === id && resolve(code)))
}

test('a resume that ends right away falls back to a new conversation', async () => {
  const cwd = tempDir()
  writeFileSync(join(cwd, '.agentify-started'), 'x')
  const agent = {
    id: 'node',
    label: 'node',
    command: 'node',
    // "--continue" with nothing to continue: prints and exits 1, like `claude --continue`.
    args: ['-e', 'console.log("nueva"); setTimeout(() => {}, 3000)'],
    resumeArgs: ['-e', 'console.log("No conversation found to continue"); process.exit(1)']
  }
  const m = new PtyManager()
  await m.open('s2', cwd, agent)
  await new Promise((r) => setTimeout(r, 2500))
  expect(m.history('s2')).toContain('nueva')
  expect(m.isOpen('s2')).toBe(true)
  await m.kill('s2')
})

test('the start prompt goes only to the first open of a session', async () => {
  const cwd = tempDir()
  const agent = {
    id: 'node',
    label: 'node',
    command: 'node',
    args: ['-e', 'console.log("args:" + process.argv.slice(1).join("|"))'],
    resumeArgs: ['-e', 'console.log("resumed:" + process.argv.slice(1).join("|"))', 'x']
  }
  const m = new PtyManager()
  let exited = waitExit(m, 's3')
  await m.open('s3', cwd, agent, {}, undefined, '/work TCK-1')
  await exited
  expect(m.history('s3')).toContain('args:/work TCK-1')
  exited = waitExit(m, 's3')
  await m.open('s3', cwd, agent, {}, undefined, '/work TCK-1')
  await exited
  expect(m.history('s3')).toContain('resumed:x')
  expect(m.history('s3').match(/work TCK-1/g)).toHaveLength(1)
})

test('agents do not inherit the markers of a Claude Code session that launched the app', async () => {
  process.env.CLAUDE_CODE_CHILD_SESSION = '1'
  process.env.CLAUDECODE = '1'
  const agent = {
    id: 'node',
    label: 'node',
    command: 'node',
    args: ['-e', 'console.log("child=" + process.env.CLAUDE_CODE_CHILD_SESSION + " cc=" + process.env.CLAUDECODE)'],
    resumeArgs: []
  }
  const m = new PtyManager()
  const exited = waitExit(m, 's4')
  await m.open('s4', tempDir(), agent)
  await exited
  expect(m.history('s4')).toContain('child=undefined cc=undefined')
  delete process.env.CLAUDE_CODE_CHILD_SESSION
  delete process.env.CLAUDECODE
})

test('first open runs args, later opens resume, history is kept', async () => {
  const cwd = tempDir()
  const agent = {
    id: 'node',
    label: 'node',
    command: 'node',
    args: ['-e', 'console.log("hola")'],
    resumeArgs: ['-e', 'console.log("otra")']
  }
  const m = new PtyManager()
  let exited = waitExit(m, 's1')
  await m.open('s1', cwd, agent)
  await exited
  expect(m.history('s1')).toContain('hola')
  expect(existsSync(join(cwd, '.agentify-started'))).toBe(true)

  exited = waitExit(m, 's1')
  await m.open('s1', cwd, agent)
  await exited
  expect(m.history('s1')).toContain('otra')
})

test('killing an agent also stops the servers it started, freeing their ports', async () => {
  const { isPortFree, portAnswers } = await import('../src/main/core/ports')
  const port = 20977
  // Like a dev server an agent runs in the background: its own process, detached from the terminal.
  const server = `require('http').createServer((q,s)=>s.end('ok')).listen(${port},'127.0.0.1')`
  const agent = {
    id: 'node',
    label: 'node',
    command: 'node',
    args: ['-e', `require('child_process').spawn(process.execPath,['-e',${JSON.stringify(server)}],{detached:true,stdio:'ignore'});setInterval(()=>{},1000)`],
    resumeArgs: []
  }
  const m = new PtyManager()
  await m.open('s5', tempDir(), agent, {}, agent.args)
  for (let i = 0; i < 50 && !(await portAnswers(port)); i++) await new Promise((r) => setTimeout(r, 100))
  expect(await portAnswers(port)).toBe(true)
  await m.kill('s5')
  expect(await isPortFree(port)).toBe(true)
})
