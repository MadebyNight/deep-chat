import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CreateMessageRequest, MessageStreamEvent } from '../api/types.js'
import { compactContext, estimateMessages, estimateRequest, selectContext } from './compaction.js'
import { toRequestMessages } from './reply.js'
import type { AssistantMessage, Message, UserMessage } from './types.js'

const user = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
})
const assistant = (id: string, text: string): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-flash',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text }],
})
const question = user('current', '请原样保留本轮输入')
const body = (history: Message[], summary?: string): CreateMessageRequest => ({
  system: 'Current system instructions',
  model: 'deepseek-flash',
  tools: [{ name: 'deepseek_web_search', type: 'deepseek_web_search' }],
  thinking: { type: 'enabled' },
  safety_check: { level: 'high' },
  messages: estimateMessages(history, question, undefined, true, undefined, summary),
})
const controller = () => new AbortController()
const first = user('first', '保留编号 WX-42。' + '较长的中文历史。'.repeat(1600))
first.files = [
  {
    id: 'local-image',
    serverId: 'file-api-old',
    name: 'chart.png',
    isImage: true,
    size: 50,
    mimeType: 'image/png',
  },
]
const original: Message[] = [
  first,
  assistant('old-answer', '确定使用 WX-42。'),
  user('recent', '最新问题'),
  assistant('recent-answer', '最新答案'),
]

async function* summaryStream(): AsyncGenerator<MessageStreamEvent> {
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '编号 ' } }
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'WX-42。' } }
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null } }
  yield { type: 'message_stop' }
}

test('short conversation stays byte-for-byte equivalent and does not invoke the model', async () => {
  const history = original.slice(2)
  const context = await selectContext(history)
  assert.deepEqual(body(history).messages, toRequestMessages(history, question))
  assert.equal(
    await compactContext(
      context,
      body,
      20_000,
      async function* () {
        assert.fail('unexpected summary')
      },
      controller().signal
    ),
    undefined
  )
})

test('summarizes old turns, keeps the recent pair and restores the checkpoint by branch content', async () => {
  const history = structuredClone(original)
  const initial = await selectContext(history)
  const summaryInputs: string[] = []
  const checkpoint = await compactContext(
    initial,
    body,
    20_000,
    async function* (request) {
      assert.deepEqual(request.tools, [])
      assert.equal(request.thinking.type, 'disabled')
      assert.ok(request.max_tokens)
      summaryInputs.push(String(request.messages[0].content))
      yield* summaryStream()
    },
    controller().signal
  )
  assert.ok(checkpoint)
  assert.equal(checkpoint.throughReplyId, 'old-answer')
  assert.match(summaryInputs.join('\n'), /chart\.png/u)
  assert.doesNotMatch(summaryInputs.join('\n'), /file-api-old|最新问题/u)
  assert.deepEqual(history, original)
  const reload = JSON.parse(JSON.stringify(checkpoint)) as typeof checkpoint
  const restored = await selectContext(history, reload)
  assert.deepEqual(restored.history, history.slice(2))
  assert.equal(restored.summary, '编号 WX-42。')
  const rebuilt = body(restored.history, restored.summary)
  assert.equal(rebuilt.system, body(history).system)
  assert.equal(rebuilt.messages.at(-1)?.content, question.content)
  assert.ok(estimateRequest(rebuilt) < 20_000)
  const hydratedAttachment = { ...first, files: [{ ...first.files[0], serverId: 'file-api-new' }] }
  assert.equal((await selectContext([hydratedAttachment, ...history.slice(1)], reload)).masked, 1)
  assert.equal(
    (await selectContext([{ ...first, content: 'Edited' }, ...history.slice(1)], reload)).masked,
    0
  )
  assert.equal(
    (
      await selectContext(
        [first, assistant('alternate-answer', '另一分支'), ...history.slice(2)],
        reload
      )
    ).masked,
    0
  )
  assert.equal((await selectContext([], reload)).masked, 0)
})

test('repeated compaction uses the previous handoff and excludes the already-covered history', async () => {
  const initial = await selectContext(original)
  const old = await compactContext(initial, body, 20_000, summaryStream, controller().signal)
  assert.ok(old)
  const history = [
    ...original,
    user('long-again', '又一轮较长的历史。'.repeat(1700)),
    assistant('new-boundary', '记录新的决定。'),
    user('tail', '近期输入'),
    assistant('tail-answer', '近期答复'),
  ]
  const updated = await compactContext(
    await selectContext(history, old),
    body,
    22_000,
    async function* (request) {
      const data = String(request.messages[0].content)
      assert.match(data, /Previous summary:\n编号 WX-42。/u)
      assert.doesNotMatch(data, /chart\.png/u)
      yield* summaryStream()
    },
    controller().signal
  )
  assert.equal(updated?.throughReplyId, 'new-boundary')
})

test('rejects interrupted, cancelled and output-limited summaries without changing history', async () => {
  const context = await selectContext(original)
  const abort = controller()
  await assert.rejects(
    compactContext(
      context,
      body,
      20_000,
      async function* () {
        abort.abort()
        yield* summaryStream()
      },
      abort.signal
    ),
    { name: 'AbortError' }
  )
  for (const reason of ['max_tokens', 'refusal'] as const) {
    await assert.rejects(
      compactContext(
        context,
        body,
        20_000,
        async function* () {
          for await (const event of summaryStream()) {
            yield event.type === 'message_delta'
              ? { ...event, delta: { ...event.delta, stop_reason: reason } }
              : event
          }
        },
        controller().signal
      ),
      { reason: 'summaryFailed' }
    )
  }
  await assert.rejects(
    compactContext(
      context,
      body,
      20_000,
      async function* () {
        for await (const event of summaryStream()) if (event.type !== 'message_stop') yield event
      },
      controller().signal
    ),
    { reason: 'summaryFailed' }
  )
  assert.equal((await selectContext(original)).masked, 0)
})

test('an explicit overflow can shrink a history that is below the estimate threshold', async () => {
  const history = [
    user('old', 'Older context. '.repeat(200)),
    assistant('old-a', 'Old answer'),
    ...original.slice(2),
  ]
  const context = await selectContext(history)
  assert.ok(estimateRequest(body(history)) < 96_000)
  const checkpoint = await compactContext(
    context,
    body,
    96_000,
    summaryStream,
    controller().signal,
    true
  )
  assert.equal(checkpoint?.throughReplyId, 'old-a')
  assert.deepEqual((await selectContext(history, checkpoint)).history, original.slice(2))
  await assert.rejects(
    compactContext(await selectContext([]), body, 96_000, summaryStream, controller().signal, true),
    { reason: 'tooLong' }
  )
})

test('explicit input overflow is distinct from output caps and generic request failures', async () => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://example.test' })
  const { ApiError } = await import('../api/client.js')
  const { isInputContextOverflow } = await import('../api/errors.js')
  assert.ok(
    isInputContextOverflow(new ApiError('http', 'Bad request', 400, 'context_length_exceeded'))
  )
  assert.ok(
    isInputContextOverflow(new ApiError('stream', 'maximum context length is 128,000 tokens'))
  )
  assert.ok(
    isInputContextOverflow(
      new ApiError('http', 'Account request failed', undefined, 'context_length_exceeded')
    )
  )
  assert.equal(isInputContextOverflow(new ApiError('http', 'Bad request', 400)), false)
  assert.equal(isInputContextOverflow(new ApiError('http', 'Payload too large', 413)), false)
  assert.equal(isInputContextOverflow(new ApiError('stream', 'max_tokens')), false)
  assert.equal(
    isInputContextOverflow(new ApiError('interrupted', 'maximum context length is 128,000 tokens')),
    false
  )
})
