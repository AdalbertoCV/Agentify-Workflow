import { expect, test } from 'vitest'
import { parseEnv, setEnvValue } from '../src/main/core/env'

test('parseEnv reads keys, skips comments, unquotes values', () => {
  expect(parseEnv('A=1\n# c\nB="x y"\n')).toEqual({ A: '1', B: 'x y' })
})

test('setEnvValue replaces an existing key in place', () => {
  expect(setEnvValue('A=1\nB=2\n', 'B', '9')).toBe('A=1\nB=9\n')
})

test('setEnvValue appends a missing key', () => {
  expect(setEnvValue('A=1\n', 'C', '3')).toBe('A=1\nC=3\n')
})
