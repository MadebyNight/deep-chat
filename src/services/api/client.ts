import { translate, type TranslationMessage } from '../../i18n/index.js'
import { recordChatRequest } from '../chat/usage.js'
import { providerRequest, type CustomProvider } from '../customProvider.js'
import { deepSeekRates, OFFICIAL_API_ORIGIN, type TokenRates } from './tokenPricing.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { applyAccountState, officialAccountRequest, officialAccountStream, type AccountState } from '../officialAccount.js'
import { customGenerationFields, type GenerationParams } from '../generation.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
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

export const accountRequestError = (error: unknown) => {
  const failure = error as { code?: string; data?: { status?: number; detail?: string } } | undefined
  const status = failure?.code === 'ACCOUNT_SIGN_IN_REQUIRED' ? 401 : failure?.data?.status
  if (status === 401) {
    void officialAccountRequest<AccountState>('state').then(applyAccountState).catch(() => undefined)
    return new ApiError('http', { key: 'connectionAccountSignInAgain' }, status, failure?.code)
  }
  if (failure?.code === 'ACCOUNT_NETWORK') {
    return new ApiError('network', { key: 'connectionAccountError' }, undefined, failure.code)
  }
  return new ApiError('http', failure?.data?.detail || { key: 'connectionAccountError' }, status, failure?.code)
}

export async function* streamOfficialMessage(body: CreateMessageRequest, signal: AbortSignal) {
  signal.throwIfAborted()
  const startedAt = new Date()
  const stream = officialAccountStream('messages', { ...body, stream: true }, signal)
  try {
    const reportUsage = recordChatRequest(
      startedAt,
      deepSeekRates(OFFICIAL_API_ORIGIN, body.model, startedAt)
    )
    yield* readMessageStream(stream, signal, reportUsage)
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) {throw error}
    throw accountRequestError(error)
  } finally {
    await stream.cancel().catch(() => undefined)
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
  const reportUsage = recordChatRequest(startedAt, deepSeekRates(API_ORIGIN, body.model, startedAt))
  const response = await pending
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  yield* readMessageStream(response.body, signal, reportUsage)
}

export type CustomMessage = { role: 'system' | 'user' | 'assistant'; content: string }
type CustomChunk = {
  model?: string
  error?: unknown
  choices?: {
    delta?: { content?: unknown; reasoning_content?: unknown; reasoning?: unknown }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } }
}

function customUsage(value: CustomChunk['usage']): MessageUsage | undefined {
  const input = value?.prompt_tokens
  const output = value?.completion_tokens
  const cached = value?.prompt_tokens_details?.cached_tokens ?? 0
  if (typeof input !== 'number' || typeof output !== 'number' ||
      ![input, output, cached].every((count) => Number.isSafeInteger(count) && count >= 0) || cached > input) {return}
  return { input_tokens: input - cached, output_tokens: output, cache_read_input_tokens: cached, cache_creation_input_tokens: 0 }
}

type RejectionError = { param?: string | null; code?: string | null; message?: string }

function rejectsParameter(target: 'stream_options' | 'reasoning_effort', rejection?: RejectionError) {
  const { param, code, message } = rejection ?? {}
  const matchesTarget =
    param === target ||
    (target === 'stream_options' && param === 'stream_options.include_usage') ||
    (typeof message === 'string' && message.toLowerCase().includes(target))
  if (!matchesTarget) {
    return false
  }
  return (
    !code ||
    code === 'unsupported_parameter' ||
    code === 'unknown_parameter' ||
    code === 'unsupported_value' ||
    code === 'invalid_value' ||
    code === 'invalid_request_error'
  )
}

export async function* streamCustomMessage(
  provider: CustomProvider,
  messages: CustomMessage[],
  signal: AbortSignal,
  rates?: TokenRates,
  options?: { thinking?: boolean; generation?: GenerationParams }
): AsyncGenerator<MessageStreamEvent> {
  signal.throwIfAborted()
  const failure = { key: 'customProviderRequestFailed' } as const
  let report: ReturnType<typeof recordChatRequest>
  let includeUsage = true
  let includeReasoning = options?.thinking !== undefined
  const reasoningEffort = options?.thinking ? 'high' : 'none'
  const send = () => {
    report = recordChatRequest(new Date(), rates)
    return providerRequest(provider, 'chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        model: provider.model,
        messages,
        stream: true,
        ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
        ...(includeReasoning ? { reasoning_effort: reasoningEffort } : {}),
        ...(options?.generation ? customGenerationFields(options.generation) : {}),
      }),
      signal,
    })
  }
  let response: Response
  try {
    response = await send()
    for (let attempt = 0; attempt < 2 && (response.status === 400 || response.status === 422); attempt++) {
      const rejection = (await response.json().catch(() => undefined)) as
        | { error?: RejectionError }
        | undefined
      if (includeUsage && rejectsParameter('stream_options', rejection?.error)) {
        includeUsage = false
      } else if (includeReasoning && rejectsParameter('reasoning_effort', rejection?.error)) {
        includeReasoning = false
      } else {
        break
      }
      signal.throwIfAborted()
      response = await send()
    }
  } catch (error) {
    signal.throwIfAborted()
    throw error instanceof ApiError ? error : new ApiError('network', failure)
  }
  if (!response.ok) {
    const error = await readErrorResponse(response)
    throw new ApiError('http', failure, error.status, error.code)
  }
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) {
    void response.body?.cancel().catch(() => undefined)
    throw new ApiError('protocol', failure)
  }
  let started = false
  let blockIndex = 0
  let openBlock: 'thinking' | 'text' | null = null
  let finished = false
  let stop: StopReason | undefined
  let usage: MessageUsage | undefined
  let matchingModel = true
  try {
    for await (const { event, data } of readServerSentEvents(response.body, signal)) {
      signal.throwIfAborted()
      if (data.trim() === '[DONE]') {
        finished = true
        break
      }
      if (event === 'error') {throw new ApiError('stream', failure)}
      let chunk: CustomChunk | null
      try {
        chunk = JSON.parse(data) as CustomChunk | null
      } catch {
        throw new ApiError('protocol', failure)
      }
      if (chunk?.error) {throw new ApiError('stream', failure)}
      if (chunk?.model && chunk.model !== provider.model) {matchingModel = false}
      usage = customUsage(chunk?.usage) ?? usage
      const choice = Array.isArray(chunk?.choices) ? chunk.choices[0] : undefined
      const reasoning =
        typeof choice?.delta?.reasoning_content === 'string'
          ? choice.delta.reasoning_content
          : typeof choice?.delta?.reasoning === 'string'
            ? choice.delta.reasoning
            : ''
      if (reasoning) {
        if (openBlock === 'text') {
          yield { type: 'content_block_stop', index: blockIndex++ }
          openBlock = null
        }
        if (openBlock === null) {
          started = true
          openBlock = 'thinking'
          yield {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          }
        }
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'thinking_delta', thinking: reasoning } }
      }
      const text = choice?.delta?.content
      if (typeof text === 'string' && text) {
        if (openBlock === 'thinking') {
          yield { type: 'content_block_stop', index: blockIndex++ }
          openBlock = null
        }
        if (openBlock === null) {
          started = true
          openBlock = 'text'
          yield { type: 'content_block_start', index: blockIndex, content_block: { type: 'text', text: '' } }
        }
        yield { type: 'content_block_delta', index: blockIndex, delta: { type: 'text_delta', text } }
      }
      switch (choice?.finish_reason) {
        case 'length':
          stop = 'max_tokens'
          break
        case 'content_filter':
          stop = 'refusal'
          break
        case 'function_call':
        case 'tool_calls':
          stop = 'tool_use'
          break
        case 'stop':
          stop = 'end_turn'
          break
      }
    }
    signal.throwIfAborted()
    if (!finished && !stop) {
      throw new ApiError('interrupted', failure)
    }
    if (stop === 'tool_use' || (!started && stop !== 'refusal')) {
      throw new ApiError('protocol', failure)
    }
    if (openBlock !== null) {
      yield { type: 'content_block_stop', index: blockIndex }
    }
    yield { type: 'message_delta', delta: { stop_reason: stop ?? 'end_turn', stop_sequence: null }, usage }
    yield { type: 'message_stop' }
  } catch (error) {
    signal.throwIfAborted()
    throw error instanceof ApiError ? error : new ApiError('network', failure)
  } finally {
    if (usage) {report?.(usage, matchingModel)}
  }
}

async function* readMessageStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  reportUsage: ReturnType<typeof recordChatRequest>
): AsyncGenerator<MessageStreamEvent> {
  let latestUsage: MessageUsage | undefined
  try {
    for await (const { event: eventName, data } of readServerSentEvents(stream, signal)) {
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
  } catch (error) {
    if (signal.aborted || error instanceof ApiError) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  } finally {
    if (latestUsage) {
      reportUsage?.(latestUsage)
    }
  }
}
