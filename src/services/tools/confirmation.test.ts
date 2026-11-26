import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  answerToolConfirmation,
  clearToolConfirmations,
  requestToolConfirmation,
  useToolConfirmation,
} from './confirmation.js'

test('queues confirmations from concurrent replies and resumes after each answer', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const firstAnswer = requestToolConfirmation(
    'reply-1',
    'tool-1',
    { name: 'write', input: { value: 1 } },
    first.signal
  )
  const secondAnswer = requestToolConfirmation(
    'reply-2',
    'tool-2',
    { name: 'delete', input: { value: 2 } },
    second.signal
  )
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.toolUseId),
    ['tool-1', 'tool-2']
  )

  answerToolConfirmation('reply-1', 'tool-1', false)
  assert.equal(await firstAnswer, false)
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.toolUseId),
    ['tool-2']
  )

  answerToolConfirmation('reply-2', 'tool-2', true)
  assert.equal(await secondAnswer, true)
  assert.deepEqual(useToolConfirmation.getState().requests, [])
})

test('cancelling a reply removes only its queued confirmations', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const firstAnswer = requestToolConfirmation(
    'reply-a',
    'tool-a',
    { name: 'write', input: {} },
    first.signal
  )
  const secondAnswer = requestToolConfirmation(
    'reply-b',
    'tool-b',
    { name: 'write', input: {} },
    second.signal
  )
  clearToolConfirmations('reply-a')
  await assert.rejects(firstAnswer, { name: 'AbortError' })
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.toolUseId),
    ['tool-b']
  )
  second.abort()
  await assert.rejects(secondAnswer, { name: 'AbortError' })
  assert.deepEqual(useToolConfirmation.getState().requests, [])
})

test('keeps identical tool ids isolated by reply', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const firstAnswer = requestToolConfirmation(
    'reply-c',
    'shared-tool-id',
    { name: 'write', input: {} },
    first.signal
  )
  const secondAnswer = requestToolConfirmation(
    'reply-d',
    'shared-tool-id',
    { name: 'write', input: {} },
    second.signal
  )
  clearToolConfirmations('reply-c')
  await assert.rejects(firstAnswer, { name: 'AbortError' })
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.replyId),
    ['reply-d']
  )
  answerToolConfirmation('reply-d', 'shared-tool-id', true)
  assert.equal(await secondAnswer, true)
})
