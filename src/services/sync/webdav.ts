import { Capacitor } from '@capacitor/core'
import { webDavHttp } from '../native.js'
import { encodeBase64 } from './crypto.js'
import { httpError, SyncError, toSyncError } from './errors.js'
import type {
  RemoteRead,
  RemoteSyncProvider,
  RemoteWrite,
  RemoteWriteCondition,
  WebDavConfig,
} from './types.js'

const MAX_URL_LENGTH = 2048
const MAX_RESPONSE_BYTES = 24 * 1024 * 1024
const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<d:propfind xmlns:d="DAV:"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getetag/>' +
  '</d:prop></d:propfind>'

const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  '::ffff:a9fe:a9fe',
  'fd00:ec2::254',
])

const invalid = (): never => {
  throw new SyncError('invalidUrl')
}

const hasControlCharacter = (value: string) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0)
    return code <= 0x1f || code === 0x7f
  })

const canonicalHost = (value: string) =>
  value.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

/** 用户配置的目录地址必须是 HTTPS，且不能携带账号、查询串或路径穿越。 */
export const normalizeWebDavUrl = (input: string): string => {
  const value = input.trim()
  if (
    !value ||
    value.length > MAX_URL_LENGTH ||
    hasControlCharacter(value) ||
    /[?#\\]/.test(value) ||
    /%2f|%25|%5c/i.test(value) ||
    /(^|\/)(?:\.|%2e){1,2}(\/|$)/i.test(value)
  ) {
    return invalid()
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return invalid()
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    return invalid()
  }
  if (METADATA_HOSTS.has(canonicalHost(url.hostname))) {
    return invalid()
  }
  const segments = url.pathname.split('/')
  if (
    segments.some((segment) => segment === '..' || segment === '.') ||
    segments.slice(1, -1).some((segment) => segment === '')
  ) {
    return invalid()
  }
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}/`
}

export const validateWebDavConfig = (config: WebDavConfig): WebDavConfig => {
  const url = normalizeWebDavUrl(config.url)
  const text = (value: string, limit: number) =>
    value.length <= limit && !hasControlCharacter(value)
  if (
    !text(config.username, 256) ||
    !text(config.password, 1024) ||
    !text(config.passphrase, 1024)
  ) {
    throw new SyncError('invalidUrl')
  }
  return { ...config, url }
}

const encodePath = (path: string): string => {
  if (!path) {
    return ''
  }
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => {
      if (segment === '..' || segment === '.') {
        throw new SyncError('invalidUrl')
      }
      return encodeURIComponent(segment)
    })
    .join('/')
}

const header = (headers: Record<string, string> | undefined, name: string) => {
  if (!headers) {
    return undefined
  }
  const key = Object.keys(headers).find((item) => item.toLowerCase() === name.toLowerCase())
  return key ? headers[key] : undefined
}

const basicAuth = (config: WebDavConfig): string | undefined => {
  if (!config.username) {
    return undefined
  }
  const bytes = new TextEncoder().encode(`${config.username}:${config.password}`)
  return `Basic ${encodeBase64(bytes)}`
}

/**
 * 受控 WebDAV 客户端。请求交由 Android 原生插件发送，避免 WebView CORS；
 * 插件与这里都拒绝明文 HTTP、跨源路径和重定向。
 */
export class WebDavClient implements RemoteSyncProvider {
  readonly kind = 'webdav' as const
  private readonly config: WebDavConfig
  private readonly basePath: string

  constructor(config: WebDavConfig) {
    this.config = validateWebDavConfig(config)
    this.basePath = new URL(this.config.url).pathname
  }

  private async request(
    path: string,
    method: 'PROPFIND' | 'MKCOL' | 'GET' | 'PUT' | 'DELETE',
    options: {
      headers?: Record<string, string>
      body?: string
      signal: AbortSignal
      timeoutMs?: number
    }
  ) {
    options.signal.throwIfAborted()
    if (Capacitor.getPlatform() !== 'android') {
      throw new SyncError('nativeOnly')
    }
    const encoded = encodePath(path)
    if (encoded && !encoded.split('/').every((segment) => segment && segment !== '..')) {
      throw new SyncError('invalidUrl')
    }
    const auth = basicAuth(this.config)
    const headers = { ...(auth ? { Authorization: auth } : {}), ...options.headers }
    let response
    try {
      response = await webDavHttp.request({
        baseUrl: this.config.url,
        path: encoded,
        method,
        headers,
        ...(options.body === undefined ? {} : { body: options.body }),
        timeoutMs: options.timeoutMs ?? 30_000,
      })
    } catch (error) {
      throw toSyncError(error)
    }
    options.signal.throwIfAborted()
    if (response.status >= 300 && response.status < 400) {
      throw new SyncError('redirect', response.status)
    }
    if ((response.body?.length ?? 0) > MAX_RESPONSE_BYTES) {
      throw new SyncError('tooLarge')
    }
    const responsePath = `${this.basePath}${encoded ? encoded : ''}`
    if (!responsePath.startsWith(this.basePath)) {
      throw new SyncError('redirect')
    }
    return response
  }

  async test(signal: AbortSignal): Promise<void> {
    const response = await this.request('', 'PROPFIND', {
      signal,
      timeoutMs: 20_000,
      headers: {
        Depth: '0',
        'Content-Type': 'application/xml; charset=utf-8',
      },
      body: PROPFIND_BODY,
    })
    if (response.status === 207 || response.status === 200 || response.status === 204) {
      return
    }
    throw httpError(response.status)
  }

  async ensureCollection(path: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(path, 'MKCOL', { signal })
    if ([200, 201, 204, 405].includes(response.status)) {
      return
    }
    throw httpError(response.status)
  }

  async read(path: string, signal: AbortSignal): Promise<RemoteRead | null> {
    const response = await this.request(path, 'GET', { signal })
    if (response.status === 404 || response.status === 410) {
      return null
    }
    if (response.status < 200 || response.status >= 300) {
      throw httpError(response.status)
    }
    return {
      text: response.body ?? '',
      ...(header(response.headers, 'ETag')
        ? { etag: header(response.headers, 'ETag') }
        : {}),
    }
  }

  async write(
    path: string,
    text: string,
    condition: RemoteWriteCondition,
    signal: AbortSignal
  ): Promise<RemoteWrite> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json; charset=utf-8',
    }
    if (condition.etag) {
      headers['If-Match'] = condition.etag
    } else if (condition.ifNoneMatch) {
      headers['If-None-Match'] = '*'
    }
    const response = await this.request(path, 'PUT', {
      signal,
      headers,
      body: text,
    })
    if ([200, 201, 204].includes(response.status)) {
      return {
        ...(header(response.headers, 'ETag')
          ? { etag: header(response.headers, 'ETag') }
          : {}),
      }
    }
    throw httpError(response.status)
  }

  async delete(path: string, signal: AbortSignal): Promise<void> {
    const response = await this.request(path, 'DELETE', { signal })
    if ([200, 202, 204, 404, 410].includes(response.status)) {
      return
    }
    throw httpError(response.status)
  }
}
