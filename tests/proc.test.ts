import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { gitBash, resolveCommand, runShell } from '../src/main/core/proc'

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
