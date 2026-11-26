import type { WebSearchResult } from '../api/types.js'
import { ExternalHttpError, externalHttpRequest } from '../tools/http.js'
import {
  SEARCH_ENDPOINTS,
  isExternalSearchConfigured,
  normalizeExternalSearch,
  type ExternalSearchConfig,
} from '../tools/config.js'

export type ExternalSearchResult = {
  title: string
  url: string
  snippet: string
  publishedAt: string | null
  siteName: string
  siteIcon: string | null
}

export type ExternalSearchErrorCode =
  | 'invalidConfig'
  | 'network'
  | 'tls'
  | 'redirect'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'unauthorized'
  | 'rateLimited'
  | 'protocol'
  | 'tooLarge'

export class ExternalSearchError extends Error {
  constructor(
    readonly code: ExternalSearchErrorCode,
    readonly status?: number
  ) {
    super(code)
    this.name = 'ExternalSearchError'
  }
}

const MAX_RESULTS = 8
const MAX_ITEMS = 500
const MAX_TITLE = 500
const MAX_SNIPPET = 1200
const MAX_QUERY = 1000

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const text = (value: unknown, limit: number): string =>
  typeof value === 'string' ? value.trim().slice(0, limit) : ''

const safeResultUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 4096) {
    return
  }
  try {
    const url = new URL(value)
    if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) {
      return url.toString()
    }
  } catch {
    return
  }
  return
}

const siteName = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

const dateValue = (value: unknown): string | null => {
  if (typeof value !== 'string' || !value.trim() || value.length > 80) {
    return null
  }
  return value.trim()
}

const result = (
  value: unknown,
  snippetField: 'content' | 'text' | 'description'
): ExternalSearchResult | undefined => {
  if (!isRecord(value)) {
    return
  }
  const url = safeResultUrl(value.url)
  if (!url) {
    return
  }
  const title = text(value.title, MAX_TITLE) || url
  const snippet = text(value[snippetField], MAX_SNIPPET)
  return {
    title,
    url,
    snippet,
    publishedAt: dateValue(value.publishedDate ?? value.published_date ?? value.page_age),
    siteName: siteName(url),
    siteIcon: null,
  }
}

const collect = (
  items: unknown,
  snippetField: 'content' | 'text' | 'description'
): ExternalSearchResult[] => {
  if (!Array.isArray(items)) {
    throw new ExternalSearchError('protocol')
  }
  const seen = new Set<string>()
  const output: ExternalSearchResult[] = []
  for (const item of items.slice(0, MAX_ITEMS)) {
    if (output.length >= MAX_RESULTS) {
      break
    }
    const mapped = result(item, snippetField)
    if (mapped && !seen.has(mapped.url)) {
      seen.add(mapped.url)
      output.push(mapped)
    }
  }
  return output
}

const parseJson = (body: string | undefined): unknown => {
  if (!body) {
    throw new ExternalSearchError('protocol')
  }
  try {
    return JSON.parse(body)
  } catch {
    throw new ExternalSearchError('protocol')
  }
}

const checkedResponse = (status: number, body: string | undefined) => {
  if (status === 401 || status === 403) {
    throw new ExternalSearchError('unauthorized', status)
  }
  if (status === 429) {
    throw new ExternalSearchError('rateLimited', status)
  }
  if (status < 200 || status >= 300) {
    throw new ExternalSearchError('http', status)
  }
  return parseJson(body)
}

const headersFor = (config: ExternalSearchConfig): Record<string, string> => ({
  Accept: 'application/json',
  ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
})

const searchSearxng = async (config: ExternalSearchConfig, query: string, signal: AbortSignal) => {
  const url = new URL(`${config.baseUrl.replace(/\/+$/, '')}/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('format', 'json')
  const response = await externalHttpRequest({
    url: url.toString(),
    method: 'GET',
    headers: headersFor(config),
    signal,
  })
  const body = checkedResponse(response.status, response.body)
  if (!isRecord(body)) {
    throw new ExternalSearchError('protocol')
  }
  return collect(body.results, 'content')
}

const searchTavily = async (config: ExternalSearchConfig, query: string, signal: AbortSignal) => {
  const response = await externalHttpRequest({
    url: `${SEARCH_ENDPOINTS.tavily}/search`,
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({
      api_key: config.apiKey,
      query,
      max_results: MAX_RESULTS,
      search_depth: 'basic',
      include_answer: false,
    }),
    signal,
  })
  const body = checkedResponse(response.status, response.body)
  if (!isRecord(body)) {
    throw new ExternalSearchError('protocol')
  }
  return collect(body.results, 'content')
}

const searchExa = async (config: ExternalSearchConfig, query: string, signal: AbortSignal) => {
  const response = await externalHttpRequest({
    url: `${SEARCH_ENDPOINTS.exa}/search`,
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: MAX_RESULTS,
      contents: { text: { maxCharacters: MAX_SNIPPET } },
    }),
    signal,
  })
  const body = checkedResponse(response.status, response.body)
  if (!isRecord(body)) {
    throw new ExternalSearchError('protocol')
  }
  return collect(body.results, 'text')
}

const searchBrave = async (config: ExternalSearchConfig, query: string, signal: AbortSignal) => {
  const url = new URL(`${SEARCH_ENDPOINTS.brave}/res/v1/web/search`)
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(MAX_RESULTS))
  const response = await externalHttpRequest({
    url: url.toString(),
    method: 'GET',
    headers: { Accept: 'application/json', 'X-Subscription-Token': config.apiKey },
    signal,
  })
  const body = checkedResponse(response.status, response.body)
  if (!isRecord(body) || !isRecord(body.web)) {
    throw new ExternalSearchError('protocol')
  }
  return collect(body.web.results, 'description')
}

const mapHttpError = (error: unknown): ExternalSearchError => {
  if (error instanceof ExternalSearchError) {
    return error
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return new ExternalSearchError('cancelled')
  }
  if (error instanceof ExternalHttpError) {
    switch (error.code) {
      case 'timeout':
        return new ExternalSearchError('timeout')
      case 'cancelled':
        return new ExternalSearchError('cancelled')
      case 'http':
        return new ExternalSearchError('http', error.status)
      case 'tooLarge':
        return new ExternalSearchError('tooLarge')
      case 'invalidUrl':
      case 'invalidRequest':
        return new ExternalSearchError('invalidConfig')
      case 'tls':
        return new ExternalSearchError('tls')
      case 'redirect':
        return new ExternalSearchError('redirect')
      default:
        return new ExternalSearchError('network')
    }
  }
  return new ExternalSearchError('network')
}

export const searchExternal = async (
  input: ExternalSearchConfig,
  rawQuery: string,
  signal: AbortSignal
): Promise<ExternalSearchResult[]> => {
  signal.throwIfAborted()
  const query = rawQuery.trim().slice(0, MAX_QUERY)
  if (!query) {
    return []
  }
  let config: ExternalSearchConfig
  try {
    config = normalizeExternalSearch(input)
  } catch {
    throw new ExternalSearchError('invalidConfig')
  }
  if (!isExternalSearchConfigured(config)) {
    throw new ExternalSearchError('invalidConfig')
  }
  try {
    switch (config.provider) {
      case 'searxng':
        return await searchSearxng(config, query, signal)
      case 'tavily':
        return await searchTavily(config, query, signal)
      case 'exa':
        return await searchExa(config, query, signal)
      case 'brave':
        return await searchBrave(config, query, signal)
    }
  } catch (error) {
    if (signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError')
    }
    throw mapHttpError(error)
  }
}

export const toWebSearchResults = (results: ExternalSearchResult[]): WebSearchResult[] =>
  results.map((item) => ({
    type: 'web_search_result',
    title: item.title,
    url: item.url,
    snippet: item.snippet,
    site_icon: item.siteIcon,
    site_name: item.siteName,
    encrypted_content: '',
    page_age: item.publishedAt,
  }))
