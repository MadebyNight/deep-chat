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
  providerRoute,
  refreshProviderPricing,
  useCustomProvider,
} from '../customProvider.js'
import {
  deepSeekRates,
  formatCostLabel,
  OFFICIAL_API_ORIGIN,
  readModelRates,
  tokenCost,
  tokenUsageCost,
} from './tokenPricing.js'

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
const sessionSystemPrompt = 'Session persona instructions'
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
  assert.deepEqual(migrated, {
    version: 3,
    providers: [provider],
    activeId: provider.id,
    fallbackProviderIds: [],
    stickyProvider: true,
  })
  assert.equal(readProviderSettings({ provider, enabled: false }).activeId, null)
  assert.throws(() => readProviderSettings({ ...migrated, activeId: 'missing' }))
  assert.deepEqual(
    readProviderSettings({
      version: 3,
      providers: [provider, { ...provider, id: 'backup' }],
      activeId: provider.id,
      fallbackProviderIds: ['backup', 'backup', provider.id, 'missing'],
      stickyProvider: false,
    }).fallbackProviderIds,
    ['backup']
  )
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
  assert.deepEqual(tokenUsageCost(usage, rates), {
    costNanos: 31_000_000,
    cacheSavedNanos: 4_000_000,
  })
  assert.deepEqual(tokenUsageCost(usage, { input: 0, output: 0, cacheRead: 0 }), {
    costNanos: 0,
    cacheSavedNanos: 0,
  })
  assert.equal(tokenUsageCost(usage, { input: 0, output: 0 }), undefined)
  const offPeak = new Date('2026-11-22T12:00:00.000Z')
  assert.deepEqual(deepSeekRates(OFFICIAL_API_ORIGIN, 'deepseek-flash', offPeak), {
    input: 1e-6,
    output: 4e-6,
    cacheRead: 0.02e-6,
  })
  assert.deepEqual(deepSeekRates(OFFICIAL_API_ORIGIN, 'deepseek-v4-pro', offPeak), {
    input: 4.5e-6,
    output: 13.5e-6,
    cacheRead: 0.15e-6,
  })
  // Beijing weekday peak windows: Mon-Fri 09:00-12:00 & 14:00-18:00 CST.
  const morningPeak = new Date('2026-11-23T01:30:00.000Z') // Mon 09:30 CST
  const afternoonPeak = new Date('2026-11-23T07:00:00.000Z') // Mon 15:00 CST
  const lunchOffPeak = new Date('2026-11-23T04:30:00.000Z') // Mon 12:30 CST
  assert.deepEqual(deepSeekRates(OFFICIAL_API_ORIGIN, 'deepseek-flash', morningPeak), {
    input: 2e-6,
    output: 8e-6,
    cacheRead: 0.04e-6,
  })
  assert.deepEqual(deepSeekRates(OFFICIAL_API_ORIGIN, 'deepseek-v4-pro', afternoonPeak), {
    input: 9e-6,
    output: 27e-6,
    cacheRead: 0.3e-6,
  })
  assert.deepEqual(deepSeekRates(OFFICIAL_API_ORIGIN, 'deepseek-flash', lunchOffPeak), {
    input: 1e-6,
    output: 4e-6,
    cacheRead: 0.02e-6,
  })
  assert.equal(deepSeekRates('https://example.test', 'deepseek-flash', offPeak), undefined)
  assert.equal(formatCostLabel(0, 'zh-CN'), '¥0.00')
  assert.equal(formatCostLabel(50_000, 'zh-CN'), '<¥0.0001')
  assert.equal(formatCostLabel(2_200_000, 'zh-CN'), '¥0.0022')
  assert.equal(formatCostLabel(31_000_000, 'zh-CN'), '¥0.03')
  assert.equal(formatCostLabel(1_234_560_000_000, 'en-US'), '¥1,234.56')
})

test('keeps a sticky session on its successful route before ordered fallbacks', () => {
  const primary = provider
  const backup1 = {
    ...provider,
    id: 'backup-1',
    baseUrl: 'https://backup-1.test/v1',
  }
  const backup2 = {
    ...provider,
    id: 'backup-2',
    baseUrl: 'https://backup-2.test/v1',
  }
  const settings = {
    version: 3 as const,
    providers: [primary, backup1, backup2],
    activeId: primary.id,
    fallbackProviderIds: [backup1.id, backup2.id],
    stickyProvider: true,
  }
  const ids = (pinned?: string) =>
    providerRoute(settings, pinned).map((item) => item.id)

  assert.deepEqual(ids(), [primary.id, backup1.id, backup2.id])
  assert.deepEqual(ids(backup2.id), [backup2.id, primary.id, backup1.id])
  assert.deepEqual(ids('missing'), [primary.id, backup1.id, backup2.id])
  assert.deepEqual(
    providerRoute({ ...settings, stickyProvider: false }, backup2.id).map((item) => item.id),
    [primary.id, backup1.id, backup2.id]
  )
  assert.deepEqual(
    providerRoute({ ...settings, fallbackProviderIds: [] }, backup1.id).map((item) => item.id),
    [backup1.id, primary.id]
  )
})

test('keeps account authorization distinct from retryable account network failures', async () => {
  Object.assign(globalThis, { __API_ORIGIN__: OFFICIAL_API_ORIGIN })
  const { accountRequestError } = await import('./client.js')
  assert.equal(
    accountRequestError({ code: 'ACCOUNT_NETWORK' }).kind,
    'network'
  )
  assert.equal(
    accountRequestError({
      code: 'ACCOUNT_HTTP',
      data: { status: 429, detail: 'busy' },
    }).status,
    429
  )
  assert.equal(
    accountRequestError({
      code: 'ACCOUNT_HTTP',
      data: { status: 503, detail: 'unavailable' },
    }).status,
    503
  )
  const unauthorized = accountRequestError({
    code: 'ACCOUNT_SIGN_IN_REQUIRED',
    data: { status: 401 },
  })
  assert.equal(unauthorized.status, 401)
  assert.equal(unauthorized.localMessage?.key, 'connectionAccountSignInAgain')
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

test('caches fallback provider prices without replacing the active route rate', async (t) => {
  const backup = {
    ...provider,
    id: 'backup-priced',
    baseUrl: 'https://backup-priced.test/v1',
  }
  useCustomProvider.setState({
    version: 3,
    providers: [provider, backup],
    activeId: provider.id,
    fallbackProviderIds: [backup.id],
    stickyProvider: true,
    provider,
    enabled: true,
    rates: undefined,
    ratesById: {},
  })
  t.after(() =>
    useCustomProvider.setState({
      version: 3,
      providers: [],
      activeId: null,
      fallbackProviderIds: [],
      stickyProvider: true,
      provider: null,
      enabled: false,
      rates: undefined,
      ratesById: {},
    })
  )
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url: RequestInfo | URL) => {
    assert.equal(url, `${backup.baseUrl}/models`)
    return Response.json(modelList('CNY', 'per_million_tokens'))
  })
  await refreshProviderPricing(backup.id)
  assert.equal(useCustomProvider.getState().rates, undefined)
  assert.equal(useCustomProvider.getState().ratesById[backup.id]?.output, rates.output)
  assert.equal(fetchMock.mock.callCount(), 1)
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
      messages: [{ role: 'system', content: sessionSystemPrompt }, ...messages],
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
    Array.fromAsync(
      streamCustomMessage(provider, messages, signal, rates, { system: sessionSystemPrompt })
    )
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
    inputTokens: 10,
    cacheReadTokens: 4,
    cacheSavedNanos: 4_000_000,
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
    inputTokens: 10,
    cacheReadTokens: 4,
    cacheSavedNanos: 4_000_000,
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

test('preserves upstream HTTP status so only transient custom-provider failures can fall back', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
  const { streamCustomMessage } = await import('./client.js')
  let status = 503
  t.mock.method(globalThis, 'fetch', async () =>
    Response.json(
      { error: { message: 'upstream failed', code: 'UPSTREAM' } },
      { status }
    )
  )
  for (const code of [401, 402, 429, 503]) {
    status = code
    await assert.rejects(
      Array.fromAsync(
        streamCustomMessage(provider, messages, new AbortController().signal, rates)
      ),
      { kind: 'http', status: code }
    )
  }
})

test('streams fragmented tool calls and caps untrusted arguments', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
  const { streamCustomMessage } = await import('./client.js')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })

  let oversized = false
  const fetchMock = t.mock.method(
    globalThis,
    'fetch',
    async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tools?: { function: { name: string } }[]
        tool_choice?: string
      }
      assert.equal(body.tools?.[0]?.function.name, 'external_web_search')
      assert.equal(body.tool_choice, 'auto')
      if (oversized) {
        return sse(
          {
            choices: [{
              delta: {
                tool_calls: [{
                  index: 0,
                  id: 'call-large',
                  function: {
                    name: 'external_web_search',
                    arguments: `{"query":"${'x'.repeat(65 * 1024)}"}`,
                  },
                }],
              },
            }],
          },
          { choices: [{ finish_reason: 'tool_calls' }] },
          '[DONE]'
        )
      }
      return sse(
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: 'call-1',
                function: { name: 'external_', arguments: '' },
              }],
            },
          }],
        },
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                function: { name: 'web_search', arguments: '{"query":"wea' },
              }],
            },
          }],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{
                  index: 0,
                  function: { arguments: 'ther"}' },
                }],
              },
              finish_reason: 'tool_calls',
            },
          ],
        },
        '[DONE]'
      )
    }
  )
  const tools = [
    {
      type: 'function' as const,
      function: {
        name: 'external_web_search',
        parameters: { type: 'object', properties: {} },
      },
    },
  ]
  const events = await Array.fromAsync(
    streamCustomMessage(provider, messages, new AbortController().signal, undefined, {
      tools,
    })
  )
  assert.deepEqual(
    events.map((event) =>
      event.type === 'content_block_start'
        ? [event.index, event.content_block.type, event.content_block]
        : event.type === 'content_block_delta'
          ? [event.index, event.delta]
          : event.type
    ),
    [
      [
        0,
        'tool_use',
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'external_web_search',
          input: {},
        },
      ],
      [0, { type: 'input_json_delta', partial_json: '{"query":"wea' }],
      [0, { type: 'input_json_delta', partial_json: 'ther"}' }],
      'content_block_stop',
      'message_delta',
      'message_stop',
    ]
  )

  oversized = true
  await assert.rejects(
    Array.fromAsync(
      streamCustomMessage(provider, messages, new AbortController().signal, undefined, {
        tools,
      })
    ),
    { kind: 'protocol' }
  )
  assert.equal(fetchMock.mock.callCount(), 2)
})

test('retries once without tools when a custom provider rejects tool definitions', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: 'https://api.deepseek.com' })
  const { streamCustomMessage } = await import('./client.js')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  let unsupported = 0
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { tools?: unknown[] }
    if (body.tools) {
      return Response.json(
        {
          error: {
            code: 'unsupported_parameter',
            param: 'tools',
            message: 'tools are not supported',
          },
        },
        { status: 400 }
      )
    }
    return sse(
      { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] },
      '[DONE]'
    )
  })
  const events = await Array.fromAsync(
    streamCustomMessage(provider, messages, new AbortController().signal, undefined, {
      tools: [
        {
          type: 'function',
          function: {
            name: 'external_web_search',
            parameters: { type: 'object', properties: {} },
          },
        },
      ],
      onToolsUnsupported: () => {
        unsupported++
      },
    })
  )
  assert.equal(unsupported, 1)
  assert.equal(events.at(-1)?.type, 'message_stop')
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

test('passes complete generation parameters to custom providers in thinking mode', async (t) => {
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
  let body: Record<string, unknown> | undefined
  t.mock.method(globalThis, 'fetch', async (_url: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>
    return sse({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }, '[DONE]')
  })
  await Array.fromAsync(
    streamCustomMessage(provider, messages, new AbortController().signal, undefined, {
      thinking: true,
      generation: {
        model: 'deepseek-flash',
        maxTokens: 12_345,
        temperature: 0.25,
        topP: 0.65,
        preset: null,
      },
    })
  )
  assert.equal(body?.model, provider.model)
  assert.equal(body?.max_tokens, 12_345)
  assert.equal(body?.temperature, 0.25)
  assert.equal(body?.top_p, 0.65)
  assert.equal(body?.reasoning_effort, 'high')
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
  assert.deepEqual(totals(), {
    calls: 1,
    reported: 1,
    tokens: 7,
    priced: 0,
    costNanos: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheSavedNanos: 0,
  })
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
    inputTokens: 20,
    cacheReadTokens: 8,
    cacheSavedNanos: 4_000_000,
  })
})

test('records official DeepSeek API costs during both peak and off-peak windows', async (t) => {
  Object.assign(globalThis, { __API_ORIGIN__: OFFICIAL_API_ORIGIN })
  const { streamMessage } = await import('./client.js')
  const { useChatUsage } = await import('../chat/usage.js')
  useChatUsage.setState({ days: {} })
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { setItem: () => undefined },
  })
  t.after(() => {
    Reflect.deleteProperty(globalThis, 'localStorage')
  })
  t.mock.method(globalThis, 'fetch', async () =>
    sse(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {
          input_tokens: 1000,
          output_tokens: 500,
          cache_read_input_tokens: 1000,
          cache_creation_input_tokens: 0,
        },
      },
      { type: 'message_stop' }
    )
  )
  const body = {
    model: 'deepseek-flash' as const,
    system: '',
    messages: [{ role: 'user' as const, content: 'hi' }],
    thinking: { type: 'disabled' as const },
    tools: [],
    safety_check: { level: 'high' as const },
  }
  let currentTime = new Date('2026-11-23T01:30:00.000Z').getTime()
  const RealDate = Date
  const FakeDate = new Proxy(RealDate, {
    construct(target, args) {
      return args.length ? Reflect.construct(target, args) : new target(currentTime)
    },
  })
  Object.defineProperty(globalThis, 'Date', { configurable: true, value: FakeDate })
  t.after(() => Object.defineProperty(globalThis, 'Date', { configurable: true, value: RealDate }))
  await Array.fromAsync(streamMessage('sk-test', body, new AbortController().signal))
  currentTime = new Date('2026-11-23T12:00:00.000Z').getTime()
  await Array.fromAsync(streamMessage('sk-test', body, new AbortController().signal))
  const day = useChatUsage.getState().days['2026-11-23']
  assert.deepEqual(day, {
    calls: 2,
    reported: 2,
    tokens: 5000,
    priced: 2,
    costNanos: 6_040_000 + 3_020_000,
    inputTokens: 4000,
    cacheReadTokens: 2000,
    cacheSavedNanos: 2_940_000,
  })
})
