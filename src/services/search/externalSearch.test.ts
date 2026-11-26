import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ExternalSearchError, searchExternal, toWebSearchResults } from './externalSearch.js'

const signal = () => new AbortController().signal
const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { 'content-type': 'application/json' },
  })

test('maps SearXNG, Tavily, Exa and Brave without putting keys in URLs', async (t) => {
  const requests: { url: string; init?: RequestInit }[] = []
  t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, init })
    assert.equal(init?.credentials, 'omit')
    assert.equal(init?.redirect, 'error')
    if (url.startsWith('https://search.example.com/search')) {
      return json({
        results: [
          {
            title: 'SearX result',
            url: 'https://one.example.com/page',
            content: 'SearX snippet',
            publishedDate: '2026-11-01',
          },
          { title: 'unsafe', url: 'javascript:alert(1)', content: 'ignored' },
        ],
      })
    }
    if (url === 'https://api.tavily.com/search') {
      return json({
        results: [
          {
            title: 'Tavily result',
            url: 'https://two.example.com/page',
            content: 'Tavily snippet',
            published_date: '2026-11-02',
          },
        ],
      })
    }
    if (url === 'https://api.exa.ai/search') {
      return json({
        results: [
          {
            title: 'Exa result',
            url: 'https://three.example.com/page',
            text: 'Exa snippet',
            publishedDate: '2026-11-03',
          },
        ],
      })
    }
    if (url.startsWith('https://api.search.brave.com/res/v1/web/search')) {
      return json({
        web: {
          results: [
            {
              title: 'Brave result',
              url: 'https://four.example.com/page',
              description: 'Brave snippet',
              page_age: '2026-11-04',
            },
          ],
        },
      })
    }
    throw new Error(`unexpected URL ${url}`)
  })

  const searx = await searchExternal(
    {
      enabled: true,
      provider: 'searxng',
      baseUrl: 'https://search.example.com',
      apiKey: '',
    },
    'release notes',
    signal()
  )
  const tavily = await searchExternal(
    {
      enabled: true,
      provider: 'tavily',
      baseUrl: '',
      apiKey: 'tavily-key',
    },
    'release notes',
    signal()
  )
  const exa = await searchExternal(
    {
      enabled: true,
      provider: 'exa',
      baseUrl: '',
      apiKey: 'exa-key',
    },
    'release notes',
    signal()
  )
  const brave = await searchExternal(
    {
      enabled: true,
      provider: 'brave',
      baseUrl: '',
      apiKey: 'brave-key',
    },
    'release notes',
    signal()
  )

  assert.deepEqual(searx, [
    {
      title: 'SearX result',
      url: 'https://one.example.com/page',
      snippet: 'SearX snippet',
      publishedAt: '2026-11-01',
      siteName: 'one.example.com',
      siteIcon: null,
    },
  ])
  assert.equal(tavily[0].title, 'Tavily result')
  assert.equal(exa[0].snippet, 'Exa snippet')
  assert.equal(brave[0].publishedAt, '2026-11-04')

  const searxRequest = requests[0]
  assert.match(searxRequest.url, /^https:\/\/search\.example\.com\/search\?/)
  assert.equal(new URL(searxRequest.url).searchParams.get('q'), 'release notes')
  const tavilyRequest = requests[1]
  assert.equal(tavilyRequest.url, 'https://api.tavily.com/search')
  assert.equal(
    (JSON.parse(String(tavilyRequest.init?.body)) as { api_key: string }).api_key,
    'tavily-key'
  )
  assert.equal(tavilyRequest.url.includes('tavily-key'), false)
  assert.equal(new Headers(requests[2].init?.headers).get('x-api-key'), 'exa-key')
  assert.equal(new Headers(requests[3].init?.headers).get('X-Subscription-Token'), 'brave-key')
  for (const request of requests.slice(1)) {
    assert.equal(request.url.includes('key'), false)
  }
})

test('caps results, validates response shape and exposes safe error codes', async (t) => {
  const results = Array.from({ length: 12 }, (_, index) => ({
    title: `Result ${index}`,
    url: `https://example${index}.com/page`,
    content: 'snippet',
  }))
  let status = 200
  let body: unknown = { results }
  t.mock.method(globalThis, 'fetch', async () => json(body, status))
  const config = {
    enabled: true,
    provider: 'searxng' as const,
    baseUrl: 'https://search.example.com',
    apiKey: '',
  }
  assert.equal((await searchExternal(config, 'query', signal())).length, 8)

  status = 429
  body = {}
  await assert.rejects(
    searchExternal(config, 'query', signal()),
    (error: unknown) => error instanceof ExternalSearchError && error.code === 'rateLimited'
  )

  status = 200
  body = { unexpected: true }
  await assert.rejects(
    searchExternal(config, 'query', signal()),
    (error: unknown) => error instanceof ExternalSearchError && error.code === 'protocol'
  )

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(searchExternal(config, 'query', aborted.signal), {
    name: 'AbortError',
  })
})

test('converts mapped results to the shared web search block shape', () => {
  assert.deepEqual(
    toWebSearchResults([
      {
        title: 'Result',
        url: 'https://example.com',
        snippet: 'Snippet',
        publishedAt: '2026-11-01',
        siteName: 'example.com',
        siteIcon: null,
      },
    ]),
    [
      {
        type: 'web_search_result',
        title: 'Result',
        url: 'https://example.com',
        snippet: 'Snippet',
        site_icon: null,
        site_name: 'example.com',
        encrypted_content: '',
        page_age: '2026-11-01',
      },
    ]
  )
})
