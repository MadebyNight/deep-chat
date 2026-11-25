import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { StreamRetryNotice } from './streamRetry.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
const [{ ApiError }, { FirstContentTimeoutError, isTransientChatError }, { streamWithPreContentRetry }] = await Promise.all([
  import('./client.js'),
  import('./errors.js'),
  import('./streamRetry.js'),
])

const immediateWait = async () => undefined
const neverEndingStream = async function* (signal: AbortSignal) {
  yield* []
  await new Promise<void>((_resolve, reject) => {
    signal.addEventListener(
      'abort',
      () => reject(new DOMException('Timed out', 'AbortError')),
      { once: true }
    )
  })
}

test('retries transient failures before content and records exponential notices', async () => {
  let calls = 0
  const notices: StreamRetryNotice[] = []
  const events = await Array.fromAsync(
    streamWithPreContentRetry({
      signal: new AbortController().signal,
      createStream: async function* () {
        calls++
        if (calls === 1) {
          throw new ApiError('http', 'busy', 503)
        }
        if (calls === 2) {
          throw new ApiError('network', 'offline')
        }
        yield { type: 'message_start' }
        yield { type: 'content_block_start' }
        yield { type: 'content_block_delta', text: 'ok' }
      },
      isContentEvent: (event) => event.type === 'content_block_start',
      onRetry: (notice) => notices.push(notice),
      wait: immediateWait,
    })
  )
  assert.equal(calls, 3)
  assert.deepEqual(notices, [
    { attempt: 1, maxRetries: 2, delayMs: 800, reason: 'transient' },
    { attempt: 2, maxRetries: 2, delayMs: 1600, reason: 'transient' },
  ])
  assert.deepEqual(events.map((event) => event.type), [
    'message_start',
    'content_block_start',
    'content_block_delta',
  ])
})

test('never retries after content, authentication, balance, or cancellation', async () => {
  let calls = 0
  const run = (error: unknown) =>
    Array.fromAsync(
      streamWithPreContentRetry({
        signal: new AbortController().signal,
        createStream: async function* () {
          calls++
          yield { type: 'content_block_start' }
          throw error
        },
        isContentEvent: (event) => event.type === 'content_block_start',
        wait: immediateWait,
      })
    )
  await assert.rejects(run(new ApiError('http', 'busy', 503)), { status: 503 })
  assert.equal(calls, 1)

  for (const status of [401, 402]) {
    calls = 0
    await assert.rejects(
      Array.fromAsync(
        streamWithPreContentRetry({
          signal: new AbortController().signal,
          createStream: async function* () {
            calls++
          yield* []
            throw new ApiError('http', 'stop', status)
          },
          isContentEvent: () => false,
          wait: immediateWait,
        })
      ),
      { status }
    )
    assert.equal(calls, 1)
  }

  const controller = new AbortController()
  controller.abort(new DOMException('Cancelled', 'AbortError'))
  calls = 0
  await assert.rejects(
    Array.fromAsync(
      streamWithPreContentRetry({
        signal: controller.signal,
        createStream: async function* () {
          calls++
          yield* []
          throw new ApiError('network', 'offline')
        },
        isContentEvent: () => false,
        wait: immediateWait,
      })
    ),
    { name: 'AbortError' }
  )
  assert.equal(calls, 0)
})

test('retries a first-content timeout and then streams normally', async () => {
  let calls = 0
  const notices: StreamRetryNotice[] = []
  const events = await Array.fromAsync(
    streamWithPreContentRetry({
      signal: new AbortController().signal,
      createStream: (signal) => {
        calls++
        return calls === 1
          ? neverEndingStream(signal)
          : (async function* () {
              yield { type: 'content_block_start' }
              yield { type: 'message_stop' }
            })()
      },
      isContentEvent: (event) => event.type === 'content_block_start',
      firstContentTimeoutMs: 5,
      onRetry: (notice) => notices.push(notice),
      wait: immediateWait,
    })
  )
  assert.equal(calls, 2)
  assert.deepEqual(notices, [
    { attempt: 1, maxRetries: 2, delayMs: 800, reason: 'timeout' },
  ])
  assert.deepEqual(events.map((event) => event.type), [
    'content_block_start',
    'message_stop',
  ])
})

test('classifies an exhausted first-content timeout so the next route can run', async () => {
  let calls = 0
  await assert.rejects(
    Array.fromAsync(
      streamWithPreContentRetry({
        signal: new AbortController().signal,
        createStream: (signal) => {
          calls++
          return neverEndingStream(signal)
        },
        isContentEvent: () => false,
        firstContentTimeoutMs: 5,
        maxRetries: 1,
        wait: immediateWait,
      })
    ),
    (error: unknown) => {
      assert.ok(error instanceof FirstContentTimeoutError)
      assert.equal(error.timeoutMs, 5)
      assert.equal(isTransientChatError(error), true)
      return true
    }
  )
  assert.equal(calls, 2)
})
