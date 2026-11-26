import { ServerSentEventDecoder } from '../api/sse.js'
import {
  ExternalHttpError,
  externalHttpRequest,
  redactSecret,
  responseHeader,
  type ExternalHttpOptions,
  type ExternalHttpResult,
} from '../tools/http.js'
import { normalizeMcpUrl } from '../tools/config.js'

const PROTOCOL_VERSION = '2025-03-26'
const MAX_TOOLS = 100
const MAX_PAGES = 10
const MAX_SCHEMA_BYTES = 16 * 1024
const MAX_ARGUMENT_BYTES = 64 * 1024
const MAX_RESULT_CHARS = 50_000
const MAX_SESSION_ID_LENGTH = 1024
const MAX_CURSOR_LENGTH = 2048
const MAX_PROTOCOL_VERSION_LENGTH = 64
const REQUEST_TIMEOUT_MS = 30_000
const INITIALIZE_TIMEOUT_MS = 15_000

export type McpErrorCode =
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
  | 'server'

export class McpError extends Error {
  constructor(
    readonly code: McpErrorCode,
    readonly status?: number,
    detail?: string
  ) {
    super(detail ? redactSecret(detail, []) : code)
    this.name = 'McpError'
  }
}

export type McpTool = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

export type McpCallResult = {
  content: string
  isError: boolean
}

type JsonRpcError = {
  code?: unknown
  message?: unknown
  data?: unknown
}

type JsonRpcResponse = {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: JsonRpcError
}

type RequestOptions = {
  signal: AbortSignal
  timeoutMs?: number
}

export type ExternalHttpTransport = (options: ExternalHttpOptions) => Promise<ExternalHttpResult>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const asText = (value: unknown, limit: number) =>
  typeof value === 'string' ? value.slice(0, limit) : ''

const rpcErrorMessage = (error: JsonRpcError | undefined, token: string) => {
  const code =
    typeof error?.code === 'number' && Number.isFinite(error.code) ? ` (${error.code})` : ''
  const message = redactSecret(
    typeof error?.message === 'string' ? error.message : 'MCP server error',
    [token]
  )
  return `MCP${code}: ${message}`
}

const mapTransportError = (error: unknown, signal: AbortSignal): McpError => {
  if (signal.aborted) {
    throw new DOMException('Cancelled', 'AbortError')
  }
  if (error instanceof ExternalHttpError) {
    switch (error.code) {
      case 'timeout':
        return new McpError('timeout')
      case 'cancelled':
        return new McpError('cancelled')
      case 'tooLarge':
        return new McpError('tooLarge')
      case 'invalidUrl':
      case 'invalidRequest':
        return new McpError('invalidConfig')
      case 'tls':
        return new McpError('tls')
      case 'redirect':
        return new McpError('redirect')
      case 'http':
        return new McpError('http', error.status)
      default:
        return new McpError('network')
    }
  }
  return new McpError('network')
}

const toolName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value)

const parseTool = (value: unknown): McpTool | undefined => {
  if (!isRecord(value) || !toolName(value.name)) {
    return
  }
  const inputSchema = isRecord(value.inputSchema)
    ? value.inputSchema
    : { type: 'object', properties: {} }
  try {
    if (JSON.stringify(inputSchema).length > MAX_SCHEMA_BYTES) {
      return
    }
  } catch {
    return
  }
  const annotations = isRecord(value.annotations) ? value.annotations : undefined
  return {
    name: value.name,
    description: asText(value.description, 1024),
    inputSchema,
    readOnly: annotations?.readOnlyHint === true && annotations?.destructiveHint !== true,
  }
}

const parseToolResult = (value: unknown): McpCallResult => {
  if (!isRecord(value)) {
    throw new McpError('protocol')
  }
  if (!Array.isArray(value.content)) {
    if (value.structuredContent !== undefined) {
      let text: string
      try {
        text = JSON.stringify(value.structuredContent)
      } catch {
        throw new McpError('protocol')
      }
      return {
        content: text.slice(0, MAX_RESULT_CHARS),
        isError: value.isError === true,
      }
    }
    throw new McpError('protocol')
  }
  const parts: string[] = []
  for (const item of value.content) {
    if (!isRecord(item)) {
      throw new McpError('protocol')
    }
    if (item.type === 'text' && typeof item.text === 'string') {
      parts.push(item.text)
    } else if (item.type === 'resource' && isRecord(item.resource)) {
      if (typeof item.resource.text === 'string') {
        parts.push(item.resource.text)
      } else if (typeof item.resource.mimeType === 'string') {
        parts.push(`[resource: ${item.resource.mimeType}]`)
      }
    } else if (item.type === 'image' && typeof item.mimeType === 'string') {
      parts.push(`[image: ${item.mimeType}]`)
    }
  }
  let content = parts.join('\n')
  if (!content && value.structuredContent !== undefined) {
    try {
      content = JSON.stringify(value.structuredContent)
    } catch {
      throw new McpError('protocol')
    }
  }
  if (content.length > MAX_RESULT_CHARS) {
    content = `${content.slice(0, MAX_RESULT_CHARS)}\n[truncated]`
  }
  return { content, isError: value.isError === true }
}

/**
 * 远程 Streamable HTTP / SSE MCP 客户端。
 * 仅使用 POST JSON-RPC；响应支持 application/json 与 text/event-stream。
 */
export class RemoteMcpClient {
  private readonly url: string
  private readonly token: string
  private sessionId: string | null = null
  private initialized = false
  private initTask: Promise<void> | undefined
  private nextId = 1

  constructor(
    config: { url: string; token?: string },
    private readonly transport: ExternalHttpTransport = externalHttpRequest
  ) {
    const url = normalizeMcpUrl(config.url)
    if (!url) {
      throw new McpError('invalidConfig')
    }
    this.url = url
    this.token = config.token?.trim() ?? ''
  }

  private headers(): Record<string, string> {
    return {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      ...(this.sessionId ? { 'Mcp-Session-Id': this.sessionId } : {}),
    }
  }

  private async post(
    body: string,
    signal: AbortSignal,
    timeoutMs: number
  ): Promise<ExternalHttpResult> {
    try {
      return await this.transport({
        url: this.url,
        method: 'POST',
        headers: this.headers(),
        body,
        signal,
        timeoutMs,
      })
    } catch (error) {
      throw mapTransportError(error, signal)
    }
  }

  private parseResponse(response: ExternalHttpResult, id: number, signal: AbortSignal) {
    signal.throwIfAborted()
    if (response.status === 401 || response.status === 403) {
      throw new McpError('unauthorized', response.status)
    }
    if (response.status === 429) {
      throw new McpError('rateLimited', response.status)
    }
    if (response.status === 404) {
      throw new McpError('http', response.status)
    }
    if (response.status < 200 || response.status >= 300) {
      throw new McpError('http', response.status)
    }
    const contentType = responseHeader(response.headers, 'content-type') ?? ''
    if (contentType.includes('text/event-stream')) {
      const decoder = new ServerSentEventDecoder()
      const events = [...decoder.push(response.body ?? ''), ...decoder.end()]
      for (const event of events) {
        if (!event.data.trim()) {
          continue
        }
        if (event.event === 'error') {
          throw new McpError('server', undefined, redactSecret(event.data, [this.token]))
        }
        let payload: unknown
        try {
          payload = JSON.parse(event.data)
        } catch {
          continue
        }
        const found = this.readRpcPayload(payload, id)
        if (found) {
          return found
        }
      }
      throw new McpError('protocol')
    }
    let payload: unknown
    try {
      payload = JSON.parse(response.body ?? '')
    } catch {
      throw new McpError('protocol')
    }
    const found = this.readRpcPayload(payload, id)
    if (!found) {
      throw new McpError('protocol')
    }
    return found
  }

  private readRpcPayload(payload: unknown, id: number): JsonRpcResponse | null {
    if (Array.isArray(payload)) {
      for (const item of payload) {
        if (isRecord(item) && item.id === id) {
          return item as JsonRpcResponse
        }
      }
      return null
    }
    if (isRecord(payload) && payload.id === id) {
      return payload as JsonRpcResponse
    }
    return null
  }

  private unwrap(response: JsonRpcResponse) {
    if (response.error) {
      throw new McpError('server', undefined, rpcErrorMessage(response.error, this.token))
    }
    return response.result
  }

  private async rpc(
    method: string,
    params: Record<string, unknown> | undefined,
    { signal, timeoutMs = REQUEST_TIMEOUT_MS }: RequestOptions
  ): Promise<unknown> {
    signal.throwIfAborted()
    const id = this.nextId++
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      ...(params === undefined ? {} : { params }),
    })
    let response = await this.post(body, signal, timeoutMs)
    if (response.status === 404 && this.sessionId) {
      this.sessionId = null
      this.initialized = false
      this.initTask = undefined
      await this.initialize(signal, INITIALIZE_TIMEOUT_MS)
      response = await this.post(body, signal, timeoutMs)
    }
    return this.unwrap(this.parseResponse(response, id, signal))
  }

  async initialize(signal: AbortSignal, timeoutMs = INITIALIZE_TIMEOUT_MS) {
    if (this.initialized) {
      return
    }
    if (this.initTask) {
      return this.initTask
    }
    this.initTask = (async () => {
      signal.throwIfAborted()
      const id = this.nextId++
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id,
        method: 'initialize',
        params: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'Deep Chat', version: '1.0' },
        },
      })
      const response = await this.post(body, signal, timeoutMs)
      if (response.status === 401 || response.status === 403) {
        throw new McpError('unauthorized', response.status)
      }
      if (response.status === 429) {
        throw new McpError('rateLimited', response.status)
      }
      if (response.status < 200 || response.status >= 300) {
        throw new McpError('http', response.status)
      }
      const session = responseHeader(response.headers, 'mcp-session-id')
      const sessionId = session?.trim() || null
      if (sessionId && sessionId.length > MAX_SESSION_ID_LENGTH) {
        throw new McpError('protocol')
      }
      const result = this.unwrap(this.parseResponse(response, id, signal))
      if (!isRecord(result)) {
        throw new McpError('protocol')
      }
      if (result.protocolVersion !== undefined) {
        if (
          typeof result.protocolVersion !== 'string' ||
          result.protocolVersion.length > MAX_PROTOCOL_VERSION_LENGTH
        ) {
          throw new McpError('protocol')
        }
      }
      this.sessionId = sessionId
      const notification = JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      })
      try {
        await this.post(notification, signal, timeoutMs)
      } catch (error) {
        if (signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) {
          throw error
        }
      }
      this.initialized = true
    })().finally(() => {
      this.initTask = undefined
    })
    return this.initTask
  }

  async listTools({ signal, timeoutMs }: RequestOptions): Promise<McpTool[]> {
    await this.initialize(signal)
    const tools = new Map<string, McpTool>()
    let cursor: string | undefined
    const seen = new Set<string>()
    for (let page = 0; page < MAX_PAGES && tools.size < MAX_TOOLS; page++) {
      const result = await this.rpc('tools/list', cursor ? { cursor } : {}, { signal, timeoutMs })
      if (!isRecord(result) || !Array.isArray(result.tools)) {
        throw new McpError('protocol')
      }
      for (const item of result.tools) {
        const tool = parseTool(item)
        if (tool && !tools.has(tool.name)) {
          tools.set(tool.name, tool)
          if (tools.size >= MAX_TOOLS) {
            break
          }
        }
      }
      if (
        typeof result.nextCursor !== 'string' ||
        !result.nextCursor ||
        seen.has(result.nextCursor)
      ) {
        break
      }
      if (result.nextCursor.length > MAX_CURSOR_LENGTH) {
        throw new McpError('protocol')
      }
      seen.add(result.nextCursor)
      cursor = result.nextCursor
    }
    return [...tools.values()]
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    { signal, timeoutMs }: RequestOptions
  ): Promise<McpCallResult> {
    if (!toolName(name)) {
      throw new McpError('invalidConfig')
    }
    let size: number
    try {
      size = JSON.stringify(args).length
    } catch {
      throw new McpError('invalidConfig')
    }
    if (size > MAX_ARGUMENT_BYTES) {
      throw new McpError('tooLarge')
    }
    await this.initialize(signal)
    const result = await this.rpc('tools/call', { name, arguments: args }, { signal, timeoutMs })
    return parseToolResult(result)
  }
}
