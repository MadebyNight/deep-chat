import { FirstContentTimeoutError, isTransientChatError } from './errors.js'

export const CHAT_RETRY_LIMIT = 2
export const CHAT_RETRY_BASE_DELAY_MS = 800
export const CHAT_FIRST_CONTENT_TIMEOUT_MS = 20_000

export type StreamRetryNotice = {
  /** 下一次请求是第几次重试，从 1 开始 */
  attempt: number
  maxRetries: number
  delayMs: number
  reason: 'transient' | 'timeout'
}

export type StreamRetryOptions<T> = {
  signal: AbortSignal
  createStream: (signal: AbortSignal) => AsyncIterable<T>
  /** 一旦出现首个内容块就禁止重试，避免重复拼接流式正文 */
  isContentEvent: (event: T) => boolean
  onRetry?: (notice: StreamRetryNotice) => void
  maxRetries?: number
  baseDelayMs?: number
  firstContentTimeoutMs?: number
  isRetryable?: (error: unknown, timedOut: boolean) => boolean
  wait?: (delayMs: number, signal: AbortSignal) => Promise<void>
}

const waitForRetry = (delayMs: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const finish = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, delayMs)
    signal.addEventListener('abort', finish, { once: true })
  })

/**
 * 首包前重试的稳定边界：每次尝试独立管理首内容块超时；收到内容块后立即停止自动重试，
 * 业务层无需自己判断是否已经输出正文。认证、余额、主动取消与参数错误由可重试判定排除。
 */
export async function* streamWithPreContentRetry<T>({
  signal,
  createStream,
  isContentEvent,
  onRetry,
  maxRetries = CHAT_RETRY_LIMIT,
  baseDelayMs = CHAT_RETRY_BASE_DELAY_MS,
  firstContentTimeoutMs = CHAT_FIRST_CONTENT_TIMEOUT_MS,
  isRetryable = isTransientChatError,
  wait = waitForRetry,
}: StreamRetryOptions<T>): AsyncGenerator<T> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    const attemptController = new AbortController()
    let timedOut = false
    const abort = () => attemptController.abort(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    let timer: ReturnType<typeof setTimeout> | undefined =
      firstContentTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            attemptController.abort()
          }, firstContentTimeoutMs)
        : undefined
    let emittedContent = false
    try {
      for await (const event of createStream(attemptController.signal)) {
        if (!emittedContent && isContentEvent(event)) {
          emittedContent = true
          clearTimeout(timer)
          timer = undefined
        }
        yield event
      }
      return
    } catch (error) {
      if (signal.aborted) {
        throw error
      }
      if (
        emittedContent ||
        attempt >= maxRetries ||
        !isRetryable(error, timedOut)
      ) {
        if (timedOut) {
          throw new FirstContentTimeoutError(firstContentTimeoutMs)
        }
        throw error
      }
      const delayMs = baseDelayMs * 2 ** attempt
      onRetry?.({
        attempt: attempt + 1,
        maxRetries,
        delayMs,
        reason: timedOut ? 'timeout' : 'transient',
      })
      await wait(delayMs, signal)
      signal.throwIfAborted()
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
    }
  }
}
