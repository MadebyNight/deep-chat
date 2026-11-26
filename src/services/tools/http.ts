import { Capacitor } from '@capacitor/core'
import { externalHttp, type ExternalHttpResponse } from '../native.js'

export type ExternalHttpErrorCode =
  | 'invalidUrl'
  | 'invalidRequest'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'tls'
  | 'redirect'
  | 'tooLarge'
  | 'http'

export class ExternalHttpError extends Error {
  constructor(
    readonly code: ExternalHttpErrorCode,
    readonly status?: number
  ) {
    super(code)
    this.name = 'ExternalHttpError'
  }
}

const MAX_URL_LENGTH = 4096
const MAX_REQUEST_BYTES = 256 * 1024
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  '::ffff:a9fe:a9fe',
  'fd00:ec2::254',
])
const ALLOWED_HEADERS = new Set([
  'accept',
  'content-type',
  'authorization',
  'mcp-session-id',
  'mcp-protocol-version',
  'last-event-id',
  'cache-control',
  'x-api-key',
  'x-subscription-token',
])
const ALLOWED_RESPONSE_HEADERS = new Set([
  'content-type',
  'mcp-session-id',
  'retry-after',
  'www-authenticate',
])
const SECRET_QUERY_KEYS = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'secret',
  'password',
  'authorization',
])

export const hasControlCharacter = (value: string) => {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) {
      return true
    }
  }
  return false
}

const parseIpv4 = (host: string): number[] | undefined => {
  const parts = host.split('.')
  if (parts.length !== 4) {
    return
  }
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : NaN))
  return octets.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? octets
    : undefined
}

const parseIpv6 = (host: string): number[] | undefined => {
  if (!host.includes(':')) {
    return
  }
  const input = host.split('%')[0]
  const halves = input.split('::')
  if (halves.length > 2) {
    return
  }
  const left = halves[0] ? halves[0].split(':') : []
  const right = halves[1] ? halves[1].split(':') : []
  const missing = 8 - left.length - right.length
  if ((halves.length === 1 && missing !== 0) || missing < 0) {
    return
  }
  const parts = [...left, ...Array.from({ length: missing }, () => '0'), ...right]
  const words = parts.map((part) =>
    /^[0-9a-f]{1,4}$/i.test(part) ? Number.parseInt(part, 16) : NaN
  )
  return words.every((part) => Number.isInteger(part) && part >= 0 && part <= 0xffff)
    ? words
    : undefined
}

const ipv4Blocked = ([first, second]: number[]) =>
  first === 0 ||
  first === 10 ||
  first === 127 ||
  (first === 100 && second >= 64 && second <= 127) ||
  (first === 169 && second === 254) ||
  (first === 172 && second >= 16 && second <= 31) ||
  (first === 192 && second === 0) ||
  (first === 192 && second === 168) ||
  (first === 198 && (second === 18 || second === 19)) ||
  (first === 198 && second === 51) ||
  (first === 203 && second === 0) ||
  first >= 224

const mappedIpv4 = (words: number[]) => [
  (words[6] >> 8) & 0xff,
  words[6] & 0xff,
  (words[7] >> 8) & 0xff,
  words[7] & 0xff,
]

const ipv6Blocked = (words: number[]) => {
  const unspecified = words.every((part) => part === 0)
  const loopback = words.slice(0, 7).every((part) => part === 0) && words[7] === 1
  const ula = (words[0] & 0xfe00) === 0xfc00
  const linkLocal = (words[0] & 0xffc0) === 0xfe80
  const siteLocal = (words[0] & 0xffc0) === 0xfec0
  const multicast = (words[0] & 0xff00) === 0xff00
  const mapped = words.slice(0, 5).every((part) => part === 0) && words[5] === 0xffff
  const compatible = words.slice(0, 6).every((part) => part === 0)
  return (
    unspecified ||
    loopback ||
    ula ||
    linkLocal ||
    siteLocal ||
    multicast ||
    ((mapped || compatible) && ipv4Blocked(mappedIpv4(words)))
  )
}

export const isBlockedExternalHostname = (hostname: string) => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (METADATA_HOSTS.has(host) || host === 'localhost' || host.endsWith('.localhost')) {
    return true
  }
  const ipv4 = parseIpv4(host)
  if (ipv4) {
    return ipv4Blocked(ipv4)
  }
  const ipv6 = parseIpv6(host)
  return ipv6 ? ipv6Blocked(ipv6) : false
}

export const validateExternalUrl = (value: string): URL => {
  const input = value.trim()
  if (
    !input ||
    input.length > MAX_URL_LENGTH ||
    hasControlCharacter(input) ||
    input.includes('\\')
  ) {
    throw new ExternalHttpError('invalidUrl')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    throw new ExternalHttpError('invalidUrl')
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    isBlockedExternalHostname(url.hostname)
  ) {
    throw new ExternalHttpError('invalidUrl')
  }
  for (const name of url.searchParams.keys()) {
    if (SECRET_QUERY_KEYS.has(name.toLowerCase())) {
      throw new ExternalHttpError('invalidUrl')
    }
  }
  return url
}

const validateHeaders = (headers: Record<string, string> | undefined) => {
  if (!headers) {
    return
  }
  let total = 0
  const names = new Set<string>()
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase()
    total += value.length
    if (
      !/^[A-Za-z0-9-]+$/.test(name) ||
      !ALLOWED_HEADERS.has(lower) ||
      names.has(lower) ||
      value.length > 8192 ||
      total > 24 * 1024 ||
      hasControlCharacter(value)
    ) {
      throw new ExternalHttpError('invalidRequest')
    }
    names.add(lower)
  }
}

const header = (headers: Record<string, string> | undefined, name: string) => {
  if (!headers) {
    return undefined
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name)
  return key ? headers[key] : undefined
}

const readLimitedText = async (response: Response) => {
  if (!response.body) {
    return ''
  }
  const length = Number(response.headers.get('content-length') ?? NaN)
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined)
    throw new ExternalHttpError('tooLarge')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        text += decoder.decode()
        return text
      }
      total += value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ExternalHttpError('tooLarge')
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
}

const nativeErrorCode = (error: unknown): string | undefined => {
  const failure = error as { code?: unknown; message?: unknown } | undefined
  if (typeof failure?.code === 'string') {
    return failure.code
  }
  if (typeof failure?.message === 'string') {
    return failure.message
  }
  return undefined
}

const mapNativeError = (error: unknown) => {
  const code = nativeErrorCode(error)
  switch (code) {
    case 'TIMEOUT':
      return new ExternalHttpError('timeout')
    case 'CANCELLED':
      return new ExternalHttpError('cancelled')
    case 'TLS':
      return new ExternalHttpError('tls')
    case 'REDIRECT_BLOCKED':
      return new ExternalHttpError('redirect')
    case 'RESPONSE_TOO_LARGE':
    case 'REQUEST_TOO_LARGE':
      return new ExternalHttpError('tooLarge')
    case 'INVALID_URL':
      return new ExternalHttpError('invalidUrl')
    case 'INVALID_REQUEST':
      return new ExternalHttpError('invalidRequest')
    default:
      return new ExternalHttpError('network')
  }
}

export type ExternalHttpResult = ExternalHttpResponse

export type ExternalHttpOptions = {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal: AbortSignal
  timeoutMs?: number
}

/**
 * 受控 HTTPS 请求：Android 走原生插件，其他平台走受限 fetch。
 * Cookie、重定向、凭据自动携带均关闭；密钥只允许放在请求头或请求体。
 */
export const externalHttpRequest = async ({
  url,
  method,
  headers,
  body,
  signal,
  timeoutMs = 30_000,
}: ExternalHttpOptions): Promise<ExternalHttpResult> => {
  signal.throwIfAborted()
  const target = validateExternalUrl(url)
  validateHeaders(headers)
  if (method === 'GET' && body !== undefined) {
    throw new ExternalHttpError('invalidRequest')
  }
  if (body !== undefined && new TextEncoder().encode(body).byteLength > MAX_REQUEST_BYTES) {
    throw new ExternalHttpError('tooLarge')
  }
  const timeout = Math.max(5000, Math.min(60_000, timeoutMs))
  const controller = new AbortController()
  let timedOut = false
  const abort = () => controller.abort(signal.reason)
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeout)
  signal.addEventListener('abort', abort, { once: true })
  const id = crypto.randomUUID()
  const cancelNative = () => {
    if (Capacitor.getPlatform() === 'android') {
      void externalHttp.cancel({ id }).catch(() => undefined)
    }
  }
  controller.signal.addEventListener('abort', cancelNative, { once: true })
  try {
    if (Capacitor.getPlatform() === 'android') {
      try {
        const result = await externalHttp.request({
          id,
          url: target.toString(),
          method,
          ...(headers ? { headers } : {}),
          ...(body === undefined ? {} : { body }),
          timeoutMs: timeout,
        })
        controller.signal.throwIfAborted()
        if (result.body && result.body.length > MAX_RESPONSE_BYTES) {
          throw new ExternalHttpError('tooLarge')
        }
        return result
      } catch (error) {
        if (timedOut) {
          throw new ExternalHttpError('timeout')
        }
        if (controller.signal.aborted) {
          throw new DOMException('Cancelled', 'AbortError')
        }
        throw mapNativeError(error)
      }
    }
    let response: Response
    try {
      response = await fetch(target, {
        method,
        ...(headers ? { headers } : {}),
        ...(body === undefined ? {} : { body }),
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        redirect: 'error',
        cache: 'no-store',
        signal: controller.signal,
      })
    } catch (error) {
      if (timedOut) {
        throw new ExternalHttpError('timeout')
      }
      if (controller.signal.aborted) {
        throw new DOMException('Cancelled', 'AbortError')
      }
      throw new ExternalHttpError('network')
    }
    const text = await readLimitedText(response)
    const responseHeaders: Record<string, string> = {}
    response.headers.forEach((value, name) => {
      if (ALLOWED_RESPONSE_HEADERS.has(name.toLowerCase())) {
        responseHeaders[name] = value
      }
    })
    return {
      status: response.status,
      headers: responseHeaders,
      body: text,
    }
  } catch (error) {
    if (error instanceof ExternalHttpError) {
      throw error
    }
    if (timedOut) {
      throw new ExternalHttpError('timeout')
    }
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    if (controller.signal.aborted) {
      throw new DOMException('Cancelled', 'AbortError')
    }
    throw new ExternalHttpError('network')
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
    controller.signal.removeEventListener('abort', cancelNative)
  }
}

export const responseHeader = header

export const redactSecret = (value: string, secrets: (string | undefined)[]) => {
  let output = value.slice(0, 500)
  for (const secret of secrets) {
    if (secret) {
      output = output.split(secret).join('[redacted]')
    }
  }
  return output
}
