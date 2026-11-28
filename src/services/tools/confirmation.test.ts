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

  answerToolConfirmation('reply-1', 'tool-1', 'deny')
  assert.equal(await firstAnswer, 'deny')
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.toolUseId),
    ['tool-2']
  )

  answerToolConfirmation('reply-2', 'tool-2', 'allow')
  assert.equal(await secondAnswer, 'allow')
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
  answerToolConfirmation('reply-d', 'shared-tool-id', 'allow')
  assert.equal(await secondAnswer, 'allow')
})

test('cancels only the selected confirmation and resumes the next queued item', async () => {
  const first = new AbortController()
  const second = new AbortController()
  const firstAnswer = requestToolConfirmation(
    'reply-e',
    'tool-e',
    { name: 'write', input: {} },
    first.signal
  )
  const secondAnswer = requestToolConfirmation(
    'reply-f',
    'tool-f',
    { name: 'delete', input: {} },
    second.signal
  )

  answerToolConfirmation('reply-e', 'tool-e', 'cancel')
  assert.equal(await firstAnswer, 'cancel')
  assert.deepEqual(
    useToolConfirmation.getState().requests.map((request) => request.toolUseId),
    ['tool-f']
  )

  answerToolConfirmation('reply-f', 'tool-f', 'allow')
  assert.equal(await secondAnswer, 'allow')
  assert.deepEqual(useToolConfirmation.getState().requests, [])
})
