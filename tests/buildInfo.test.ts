import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { buildInfo, newerOnDisk } from '../src/main/core/buildInfo'
import { git, makeOriginAndClone, tempDir } from './helpers/git'

test('reads the version and the commit the app started from', async () => {
  const { clone } = makeOriginAndClone(tempDir())
  writeFileSync(join(clone, 'package.json'), JSON.stringify({ version: '9.9.9' }))
  const info = await buildInfo(clone)
  expect(info).toEqual({ version: '9.9.9', commit: git(clone, 'rev-parse', '--short', 'HEAD') })
})

test('a newer commit on disk is reported, the same one is not', async () => {
  const { clone } = makeOriginAndClone(tempDir())
  writeFileSync(join(clone, 'package.json'), JSON.stringify({ version: '1.0.0' }))
  const info = await buildInfo(clone)
  expect(await newerOnDisk(clone, info)).toBeNull()
  writeFileSync(join(clone, 'x.txt'), 'x')
  git(clone, 'add', '.')
  git(clone, 'commit', '-qm', 'new')
  expect(await newerOnDisk(clone, info)).toBe(git(clone, 'rev-parse', '--short', 'HEAD'))
})

test('outside a git checkout (installed app) there is no commit and nothing to compare', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ version: '1.0.1' }))
  const info = await buildInfo(dir)
  expect(info).toEqual({ version: '1.0.1' })
  expect(await newerOnDisk(dir, info)).toBeNull()
})
