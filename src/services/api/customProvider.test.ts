import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  fetchProviderModels,
  matchesChatProvider,
  readProviderSettings,
  removeCustomProvider,
  saveCustomProvider,
  selectCustomProvider,
  normalizeProviderUrl,
  refreshProviderPricing,
  useCustomProvider,
} from '../customProvider.js'
import { deepSeekRates, readModelRates, tokenCost } from './tokenPricing.js'

const provider = {
  id: 'provider-v1',
  baseUrl: 'https://example.test/prefix/v1',
  apiKey: 'fixture-key',
  model: 'test-model',
}
const rates = { input: 0.002, output: 0.003, cacheRead: 0.001 }
const usage = {
  input_tokens: 6,
  output_tokens: 5,
  cache_read_input_tokens: 4,
  cache_creation_input_tokens: 0,
}
const modelList = (currency: string, unit: string) => ({
  data: [
    {
      id: provider.model,
      pricing: { currency, unit, input: 2000, output: 3000, cache_read: 1000 },
    },
  ],
})
const messages = [{ role: 'user' as const, content: 'test prompt' }]
const sse = (...events: (object | string)[]) =>
  new Response(
    events
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } }
  )

test('validates endpoint and keeps a chat associated with its configuration', () => {
  assert.equal(normalizeProviderUrl(`${provider.baseUrl}/chat/completions/`), provider.baseUrl)
  for (const url of [
    'http://example.test',
    'https://user:password@example.test',
    'https://example.test/?query',
    'https://example.test/#hash',
  ]) {
    assert.equal(normalizeProviderUrl(url), undefined)
  }
  assert.equal(matchesChatProvider(provider.id, true, provider.id), true)
  assert.equal(matchesChatProvider(provider.id, true, 'provider-v2'), false)
  assert.equal(matchesChatProvider(undefined, true, provider.id), false)
  assert.equal(matchesChatProvider(provider.id, false, provider.id), false)
  assert.equal(matchesChatProvider(undefined, false), true)
})

test('migrates the saved provider and preserves selection across list changes', async (t) => {
  const migrated = readProviderSettings({ provider, enabled: true })
  assert.deepEqual(migrated, { version: 2, providers: [provider], activeId: provider.id })
  assert.equal(readProviderSettings({ provider, enabled: false }).activeId, null)
  assert.throws(() => readProviderSettings({ ...migrated, activeId: 'missing' }))
  useCustomProvider.setState({ ...migrated, provider, enabled: true })
  t.after(() => useCustomProvider.setState({ providers: [], activeId: null, provider: null, enabled: false, rates: undefined }))
  const other = { ...provider, id: 'second', apiKey: 'second-key', baseUrl: 'https://other.test/v1' }
  const mock = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, `${other.baseUrl}/models`)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer second-key')
    return Response.json({ data: [] })
  })
  assert.equal(await saveCustomProvider(other), false)
  assert.equal(useCustomProvider.getState().provider, provider)
  assert.equal(mock.mock.callCount(), 0)
  assert.equal(await selectCustomProvider(other.id), true)
  assert.equal(useCustomProvider.getState().provider, other)
  assert.equal(mock.mock.callCount(), 1)
  assert.equal(await removeCustomProvider(other.id), true)
  assert.equal(useCustomProvider.getState().enabled, false)
  assert.deepEqual(useCustomProvider.getState().providers, [provider])
})

test('fetches distinct upstream model IDs with the draft credentials and supports cancellation', async (t) => {
  const mock = t.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    assert.equal(url, `${provider.baseUrl}/models`)
    assert.equal(new Headers(init?.headers).get('Authorization'), 'Bearer fixture-key')
    assert.equal(init?.redirect, 'error')
    init?.signal?.throwIfAborted()
    return Response.json({ data: [{ id: 'one' }, { id: 'one' }, { id: 'Two' }, { id: '' }, { id: 42 }] })
  })
  const controller = new AbortController()
  assert.deepEqual(await fetchProviderModels(provider, controller.signal), ['one', 'Two'])
  controller.abort()
  await assert.rejects(fetchProviderModels(provider, controller.signal), { name: 'AbortError' })
  mock.mock.mockImplementation(async () => Response.json({ data: [] }))
  assert.deepEqual(await fetchProviderModels(provider, new AbortController().signal), [])
})

test('interprets only model-specific prices with a known CNY unit', () => {
  assert.deepEqual(readModelRates(modelList('CNY', 'per_million_tokens'), provider.model), {
    ...rates,
    cacheWrite: undefined,
  })
  assert.equal(readModelRates(modelList('USD', 'per_million_tokens'), provider.model), undefined)
  assert.equal(readModelRates(modelList('CNY', 'unknown'), provider.model), undefined)
  assert.equal(readModelRates(modelList('CNY', 'per_million_tokens'), 'another'), undefined)
  assert.equal(tokenCost(usage, rates), 31_000_000)
  assert.equal(tokenCost(usage, { input: 0, output: 0, cacheRead: 0 }), 0)
  assert.equal(tokenCost(usage, { input: 0, output: 0 }), undefined)
  const offPeak = new Date('2026-11-22T12:00:00.000Z')
  assert.ok(deepSeekRates('https://api.deepseek.com', 'deepseek-flash', offPeak))
  assert.equal(deepSeekRates('https://example.test', 'deepseek-flash', offPeak), undefined)
})

test('loads prices from the configured endpoint, clearing unavailable metadata', async (t) => {
  useCustomProvider.setState({ provider, enabled: true })
  t.after(() => useCustomProvider.setState({ provider: null, enabled: false, rates: undefined }))
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, `${provider.baseUrl}/models`)
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${provider.apiKey}`)
    assert.equal(init?.redirect, 'error')
    return Response.json(modelList('CNY', 'per_million_tokens'))
  })
  await refreshProviderPricing()
  assert.equal(useCustomProvider.getState().rates?.output, rates.output)
  fetchMock.mock.mockImplementation(async () => {
    throw new Error('offline')
  })
  await refreshProviderPricing()
  assert.equal(useCustomProvider.getState().rates, undefined)
  assert.equal(useCustomProvider.getState().enabled, true)
})

test('handles late usage frames, missing usage, and interrupted or aborted streams', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
  const { streamCustomMessage } = await import('./client.js')
  const { useChatUsage } = await import('../chat/usage.js')
  useChatUsage.setState({ days: {} })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL, init?: RequestInit) => {
    assert.equal(url, `${provider.baseUrl}/chat/completions`)
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.redirect, 'error')
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('Authorization'), `Bearer ${provider.apiKey}`)
    assert.equal(headers.get('x-api-key'), null)
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: provider.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
    })
    const measured = {
      usage: {
        prompt_tokens: 10,
        completion_tokens: 5,
        prompt_tokens_details: { cached_tokens: 4 },
      },
    }
    return sse(
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ finish_reason: 'stop' }] },
      measured,
      measured,
      '[DONE]'
    )
  })
  const collect = (signal = new AbortController().signal) =>
    Array.fromAsync(streamCustomMessage(provider, messages, signal, rates))
  const totals = () => Object.values(useChatUsage.getState().days)[0]
  const events = await collect()
  assert.equal(events[1].type, 'content_block_delta')
  assert.deepEqual(events.at(-2), {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage,
  })
  assert.deepEqual(totals(), {
    calls: 1,
    reported: 1,
    tokens: 15,
    priced: 1,
    costNanos: 31_000_000,
  })

  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (JSON.parse(String(init?.body)).stream_options) {
      return Response.json(
        { error: { code: 'unsupported_parameter', param: 'stream_options' } },
        { status: 400 }
      )
    }
    return sse(
      { choices: [{ delta: { content: 'without usage' }, finish_reason: 'stop' }] },
      '[DONE]'
    )
  })
  assert.equal((await collect()).at(-1)?.type, 'message_stop')
  assert.deepEqual(totals(), {
    calls: 3,
    reported: 1,
    tokens: 15,
    priced: 1,
    costNanos: 31_000_000,
  })
  fetchMock.mock.mockImplementation(async () =>
    sse({ choices: [{ delta: { content: 'partial' } }] })
  )
  await assert.rejects(collect(), { kind: 'interrupted' })
  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(collect(aborted.signal), { name: 'AbortError' })
  assert.equal(fetchMock.mock.callCount(), 4)
})

test('streams custom provider reasoning blocks and falls back when reasoning_effort is rejected', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
  const { streamCustomMessage } = await import('./client.js')
  const { useChatUsage } = await import('../chat/usage.js')
  useChatUsage.setState({ days: {} })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  const bodies: Record<string, unknown>[] = []
  const fetchMock = t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (body.reasoning_effort === 'none') {
      return Response.json(
        { error: { code: 'invalid_value', param: 'reasoning_effort', message: 'Invalid reasoning_effort' } },
        { status: 400 }
      )
    }
    return sse(
      { choices: [{ delta: { reasoning_content: 'step 1 ' } }] },
      { choices: [{ delta: { reasoning: 'step 2' } }] },
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      '[DONE]'
    )
  })

  const thinkingEvents = await Array.fromAsync(
    streamCustomMessage(provider, messages, new AbortController().signal, undefined, { thinking: true })
  )
  assert.equal(bodies[0].reasoning_effort, 'high')
  assert.deepEqual(
    thinkingEvents.map((event) =>
      event.type === 'content_block_start'
        ? `${event.index}:${event.content_block.type}`
        : event.type === 'content_block_delta'
          ? event.delta.type === 'thinking_delta'
            ? `t:${event.delta.thinking}`
            : event.delta.type === 'text_delta'
              ? `x:${event.delta.text}`
              : event.delta.type
          : `${event.type}${'index' in event ? `:${event.index}` : ''}`
    ),
    [
      '0:thinking',
      't:step 1 ',
      't:step 2',
      'content_block_stop:0',
      '1:text',
      'x:answer',
      'content_block_stop:1',
      'message_delta',
      'message_stop',
    ]
  )

  fetchMock.mock.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    bodies.push(body)
    if (body.reasoning_effort === 'none') {
      return Response.json(
        { error: { code: 'invalid_value', param: 'reasoning_effort', message: 'Unsupported value: none' } },
        { status: 400 }
      )
    }
    return sse({ choices: [{ delta: { content: 'plain' }, finish_reason: 'stop' }] }, '[DONE]')
  })

  const fallbackEvents = await Array.fromAsync(
    streamCustomMessage(provider, messages, new AbortController().signal, undefined, { thinking: false })
  )
  assert.equal(bodies[1].reasoning_effort, 'none')
  assert.equal('reasoning_effort' in bodies[2], false)
  assert.equal(fallbackEvents.at(-1)?.type, 'message_stop')
})

test('loads legacy usage with a zero cost and retains known amounts when requests go unpriced', async (t) => {
  let stored = JSON.stringify({ '2026-11-01': { calls: 1, reported: 1, tokens: 7 } })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: () => stored,
      setItem: (_name: string, value: string) => {
        stored = value
      },
    },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  const { useChatUsage, refreshChatUsage, recordChatRequest } = await import('../chat/usage.js')
  refreshChatUsage()
  const totals = () => useChatUsage.getState().days['2026-11-01']
  assert.deepEqual(totals(), { calls: 1, reported: 1, tokens: 7, priced: 0, costNanos: 0 })
  const time = new Date(2026, 10, 1, 12)
  recordChatRequest(time, rates)?.(usage)
  recordChatRequest(time)?.(usage)
  refreshChatUsage()
  assert.deepEqual(totals(), {
    calls: 3,
    reported: 3,
    tokens: 37,
    priced: 1,
    costNanos: 31_000_000,
  })
})
