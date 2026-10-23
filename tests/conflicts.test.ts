import { expect, test } from 'vitest'
import { parseConflicts, resolveConflicts } from '../src/main/core/conflicts'

const two = [
  'a',
  '<<<<<<< HEAD',
  'main 1',
  '=======',
  'branch 1',
  '>>>>>>> 1234abc (my change)',
  'b',
  '<<<<<<< HEAD',
  'main 2',
  '=======',
  'branch 2a',
  'branch 2b',
  '>>>>>>> 1234abc (my change)',
  'c',
  ''
].join('\n')

test('splits text and conflicts, main is the HEAD side during a rebase', () => {
  expect(parseConflicts(two)).toEqual([
    { kind: 'text', text: 'a\n' },
    { kind: 'conflict', main: 'main 1\n', branch: 'branch 1\n' },
    { kind: 'text', text: 'b\n' },
    { kind: 'conflict', main: 'main 2\n', branch: 'branch 2a\nbranch 2b\n' },
    { kind: 'text', text: 'c\n' }
  ])
})

test('resolves each conflict with the chosen side, or both (main first)', () => {
  expect(resolveConflicts(parseConflicts(two), ['branch', 'both'])).toBe('a\nbranch 1\nb\nmain 2\nbranch 2a\nbranch 2b\nc\n')
  expect(resolveConflicts(parseConflicts(two), ['main', 'main'])).toBe('a\nmain 1\nb\nmain 2\nc\n')
})

test('drops the base section of diff3 / zdiff3 markers', () => {
  const text = '<<<<<<< HEAD\nmain\n||||||| parent of 1234abc\nbase\n=======\nbranch\n>>>>>>> 1234abc\n'
  expect(parseConflicts(text)).toEqual([{ kind: 'conflict', main: 'main\n', branch: 'branch\n' }])
})

test('keeps CRLF line endings', () => {
  const text = 'a\r\n<<<<<<< HEAD\r\nmain\r\n=======\r\nbranch\r\n>>>>>>> x\r\nb\r\n'
  expect(resolveConflicts(parseConflicts(text), ['branch'])).toBe('a\r\nbranch\r\nb\r\n')
})

test('a file without markers is one text chunk', () => {
  expect(parseConflicts('just text\n')).toEqual([{ kind: 'text', text: 'just text\n' }])
})
