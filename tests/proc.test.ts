import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { childEnv, gitBash, resolveCommand, runShell } from '../src/main/core/proc'

test.skipIf(process.platform !== 'win32')('gitBash resolves Git for Windows bash, never WSL', async () => {
  const bash = await gitBash()
  expect(existsSync(bash)).toBe(true)
  expect(bash.toLowerCase()).not.toContain('system32')
  expect(bash.toLowerCase()).not.toContain('windowsapps')
})

test.skipIf(process.platform !== 'win32')('resolveCommand walks PATH and unwraps npm .cmd shims to the real exe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-path-'))
  const exe = join(dir, 'node_modules', '@x', 'tool', 'bin', 'tool.exe')
  mkdirSync(join(dir, 'node_modules', '@x', 'tool', 'bin'), { recursive: true })
  writeFileSync(exe, '')
  writeFileSync(
    join(dir, 'tool.cmd'),
    '@ECHO off\r\nSETLOCAL\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@x\\tool\\bin\\tool.exe"   %*\r\n'
  )
  writeFileSync(join(dir, 'tool'), '#!/bin/sh\n')
  const r = await resolveCommand('tool', ['--continue'], `${dir};C:\\nope`)
  expect(r).toEqual({ file: exe, args: ['--continue'] })
})

test.skipIf(process.platform !== 'win32')('resolveCommand runs a plain .cmd through cmd.exe', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentify-path-'))
  writeFileSync(join(dir, 'plain.cmd'), '@echo hi\r\n')
  const r = await resolveCommand('plain', ['a'], dir)
  expect(r.file.toLowerCase()).toMatch(/cmd.exe$/)
  expect(r.args).toEqual(['/d', '/s', '/c', join(dir, 'plain.cmd'), 'a'])
})

test('resolveCommand reports a command that is not installed', async () => {
  await expect(resolveCommand('definitely-not-installed-xyz', [], '')).rejects.toThrow(/No encontré/)
})

test('runShell runs a bash line with the extra env', async () => {
  const { stdout } = await runShell('echo "$FOO-$PYTHONUTF8"', { cwd: process.cwd(), env: { FOO: 'bar' } })
  expect(stdout.trim()).toBe('bar-1')
})

test('children do not inherit the NODE_ENV electron-vite gave the app', () => {
  const launched = {
    PATH: 'p',
    NODE_ENV: 'production',
    NODE_ENV_ELECTRON_VITE: 'production',
    ELECTRON_RENDERER_URL: 'http://localhost:5173'
  }
  expect(childEnv(launched)).toEqual({ PATH: 'p' })
})

test('a NODE_ENV the user set on purpose reaches the children', () => {
  expect(childEnv({ PATH: 'p', NODE_ENV: 'staging' })).toEqual({ PATH: 'p', NODE_ENV: 'staging' })
})

test('a shell line run by the app does not see the launcher NODE_ENV', async () => {
  const before = { ...process.env }
  Object.assign(process.env, { NODE_ENV: 'production', NODE_ENV_ELECTRON_VITE: 'production' })
  try {
    const { stdout } = await runShell('echo "[${NODE_ENV:-}]"', { cwd: tmpdir() })
    expect(stdout.trim()).toBe('[]')
  } finally {
    for (const k of ['NODE_ENV', 'NODE_ENV_ELECTRON_VITE']) {
      if (before[k] === undefined) delete process.env[k]
      else process.env[k] = before[k]
    }
  }
})
