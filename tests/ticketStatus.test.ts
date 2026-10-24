import { expect, test } from 'vitest'
import { githubStatus, linearStatus, selectable } from '../src/main/core/ticketStatus'

test('Linear: backlog, ready and todo are free to pick', () => {
  expect(linearStatus({ name: 'Backlog', type: 'backlog' }, [])).toEqual({ status: 'ready' })
  expect(linearStatus({ name: 'Ready', type: 'unstarted' }, [])).toEqual({ status: 'ready' })
  expect(linearStatus({ name: 'Triage', type: 'triage' }, [])).toEqual({ status: 'ready' })
})

test('Linear: started states are in progress, or in review when the name says so', () => {
  expect(linearStatus({ name: 'In Progress', type: 'started' }, [])).toEqual({ status: 'in-progress' })
  expect(linearStatus({ name: 'In Review', type: 'started' }, [])).toEqual({ status: 'in-review' })
})

test('Linear: an unfinished blocker blocks and is named; finished blockers do not', () => {
  const blockers = [
    { type: 'blocks', issue: { identifier: 'TCK-9', state: { type: 'backlog' } } },
    { type: 'blocks', issue: { identifier: 'TCK-8', state: { type: 'completed' } } },
    { type: 'related', issue: { identifier: 'TCK-7', state: { type: 'started' } } }
  ]
  expect(linearStatus({ name: 'Backlog', type: 'backlog' }, blockers)).toEqual({
    status: 'blocked',
    blockedBy: ['TCK-9']
  })
  expect(linearStatus({ name: 'Backlog', type: 'backlog' }, blockers.slice(1))).toEqual({ status: 'ready' })
})

test('Linear: a state called Blocked is blocked even with no relation', () => {
  expect(linearStatus({ name: 'Blocked', type: 'started' }, [])).toEqual({ status: 'blocked' })
})

test('GitHub: open blockers and blocked labels block; review and progress come from labels', () => {
  expect(githubStatus([], [{ ref: 'org/api#3', open: true }])).toEqual({ status: 'blocked', blockedBy: ['org/api#3'] })
  expect(githubStatus([], [{ ref: 'org/api#3', open: false }])).toEqual({ status: 'ready' })
  expect(githubStatus(['Blocked'], [])).toEqual({ status: 'blocked' })
  expect(githubStatus(['in review'], [])).toEqual({ status: 'in-review' })
  expect(githubStatus(['In Progress'], [])).toEqual({ status: 'in-progress' })
  expect(githubStatus(['bug'], [])).toEqual({ status: 'ready' })
})

test('only ready tickets can start a session', () => {
  expect(selectable('ready')).toBe(true)
  expect(['blocked', 'in-progress', 'in-review'].map((s) => selectable(s as never))).toEqual([false, false, false])
})
