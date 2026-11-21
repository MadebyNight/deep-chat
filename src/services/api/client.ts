import { translate, type TranslationMessage } from '../../i18n/index.js'
import { recordChatRequest } from '../chat/usage.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { applyAccountState, officialAccountChunks, officialAccountRequest, type AccountState } from '../officialAccount.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  MessageUsage,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number,
    readonly code?: string
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  let code: string | undefined
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
      code = body.error.code ?? body.error.type
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status, code)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

export async function* streamOfficialMessage(
  body: CreateMessageRequest, signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  signal.throwIfAborted()
  const reportUsage = recordChatRequest(new Date())
  let usage: MessageUsage | undefined
  let stopReason: 'end_turn' | 'max_tokens' | undefined
  let searchId = ''
  // The two local search blocks precede the provider's non-negative stream indexes.
  const searchIndex = -2
  const resultsIndex = -1
  try {
    for await (const chunk of officialAccountChunks(body, signal)) {
      switch (chunk.type) {
        case 'search-start':
          searchId = `srvtoolu_s_0_${crypto.randomUUID().replaceAll('-', '')}`
          yield { type: 'content_block_start', index: searchIndex, content_block: {
            type: 'server_tool_use', id: searchId, name: 'deepseek_web_search', kind: 'search',
            caller: { type: 'direct' }, input: { action: 'search', queries: [chunk.query] },
          } }
          yield { type: 'content_block_stop', index: searchIndex }
          break
        case 'search-results':
          yield { type: 'content_block_start', index: resultsIndex, content_block: {
            type: 'web_search_tool_result', tool_use_id: searchId, kind: 'search',
            content: chunk.sources.map(({ url, title, snippet }) => ({
              type: 'web_search_result', url, title, snippet, site_icon: null, site_name: null,
              encrypted_content: '', page_age: null,
            })),
          } }
          yield { type: 'content_block_stop', index: resultsIndex }
          break
        case 'block-start':
          if (chunk.blockType === 'text' || chunk.blockType === 'reasoning') {
            yield { type: 'content_block_start', index: chunk.index,
              content_block: chunk.blockType === 'text'
                ? { type: 'text', text: '' }
                : { type: 'thinking', thinking: '', signature: '' } }
          }
          break
        case 'text-delta':
          yield { type: 'content_block_delta', index: chunk.index, delta: { type: 'text_delta', text: chunk.text } }
          break
        case 'reasoning-delta':
          yield { type: 'content_block_delta', index: chunk.index, delta: { type: 'thinking_delta', thinking: chunk.text } }
          break
        case 'block-end':
          yield { type: 'content_block_stop', index: chunk.index }
          break
        case 'usage':
          usage = {
            input_tokens: chunk.usage.inputTokens,
            output_tokens: chunk.usage.outputTokens,
            cache_creation_input_tokens: chunk.usage.cacheWriteTokens ?? 0,
            cache_read_input_tokens: chunk.usage.cacheReadTokens ?? 0,
          }
          break
        case 'finish':
          if (chunk.reason === 'stop' || chunk.reason === 'max-tokens') {
            stopReason = chunk.reason === 'stop' ? 'end_turn' : 'max_tokens'
          }
          break
      }
    }
    if (!stopReason) {throw new ApiError('interrupted', '')}
    yield { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage }
    yield { type: 'message_stop' }
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) {throw error}
    const failure = error as { code?: string; data?: { status?: number } }
    const status = failure?.code === 'ACCOUNT_SIGN_IN_REQUIRED' ? 401
      : failure?.code === 'QUOTA' ? 402 : failure?.data?.status
    if (status === 401) {
      void officialAccountRequest<AccountState>('state').then(applyAccountState).catch(() => undefined)
    }
    const key = failure?.code === 'ACCOUNT_SEARCH_FAILED' ? 'connectionAccountSearchFailed'
      : failure?.code === 'ACCOUNT_ATTACHMENT' ? 'connectionAccountAttachment' : 'connectionAccountError'
    throw new ApiError('http', { key }, status, failure?.code)
  } finally {
    if (usage) {reportUsage?.(usage)}
  }
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  signal.throwIfAborted()
  const init: RequestInit = {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
    signal,
  }
  signal.throwIfAborted()
  const startedAt = new Date()
  const pending = request(`${ANTHROPIC_BASE_URL}/messages`, init)
  const reportUsage = recordChatRequest(startedAt)
  const response = await pending
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  let latestUsage: MessageUsage | undefined
  try {
    for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
      let payload: unknown
      try {
        payload = JSON.parse(data)
      } catch {
        if (eventName !== 'error') {
          continue
        }
      }
      if (isErrorBody(payload)) {
        throw new ApiError('stream', payload.error.message, undefined, payload.error.code ?? payload.error.type)
      }
      if (eventName === 'error') {
        throw new ApiError('stream', data)
      }
      const event = readMessageEvent(payload)
      if (!event) {
        continue
      }
      if (event.type === 'message_delta' && event.usage) {
        const counts = [
          event.usage.input_tokens,
          event.usage.cache_read_input_tokens,
          event.usage.cache_creation_input_tokens,
          event.usage.output_tokens,
        ]
        if (
          counts.every((count) => Number.isSafeInteger(count) && count >= 0) &&
          Number.isSafeInteger(counts.reduce((total, count) => total + count, 0))
        ) {
          latestUsage = event.usage
        }
      }
      yield event
      if (event.type === 'message_stop') {
        return
      }
    }
    // 服务端没有提供错误内容时保持为空，不推测断流原因。
    throw new ApiError('interrupted', '')
  } finally {
    if (latestUsage) {
      reportUsage?.(latestUsage)
    }
  }
}
