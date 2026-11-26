/** 同步失败分类；UI 只翻译错误码，不展示远端返回的原文。 */
export type SyncErrorCode =
  | 'aborted'
  | 'auth'
  | 'busy'
  | 'conflict'
  | 'corrupt'
  | 'decrypt'
  | 'forbidden'
  | 'insecure'
  | 'invalidUrl'
  | 'localStorage'
  | 'locked'
  | 'missingConfig'
  | 'nativeOnly'
  | 'network'
  | 'notFound'
  | 'quota'
  | 'rateLimited'
  | 'redirect'
  | 'server'
  | 'timeout'
  | 'tooLarge'
  | 'tls'
  | 'unknown'
  | 'unsupported'

export class SyncError extends Error {
  constructor(
    readonly code: SyncErrorCode,
    readonly status?: number
  ) {
    super(code)
    this.name = 'SyncError'
  }
}

const nativeCodes: Record<string, SyncErrorCode> = {
  AUTH_REQUIRED: 'auth',
  FORBIDDEN: 'forbidden',
  INSECURE_URL: 'insecure',
  INVALID_URL: 'invalidUrl',
  METHOD_NOT_ALLOWED: 'server',
  NETWORK: 'network',
  NOT_FOUND: 'notFound',
  REDIRECT_BLOCKED: 'redirect',
  REQUEST_TOO_LARGE: 'tooLarge',
  RESPONSE_TOO_LARGE: 'tooLarge',
  TIMEOUT: 'timeout',
  TLS: 'tls',
  UNAUTHORIZED: 'auth',
}

const statusCode = (status: number): SyncErrorCode => {
  if (status === 401) {
    return 'auth'
  }
  if (status === 403) {
    return 'forbidden'
  }
  if (status === 404 || status === 410) {
    return 'notFound'
  }
  if (status === 408) {
    return 'timeout'
  }
  if (status === 409 || status === 412) {
    return 'conflict'
  }
  if (status === 413 || status === 414) {
    return 'tooLarge'
  }
  if (status === 423) {
    return 'locked'
  }
  if (status === 429) {
    return 'rateLimited'
  }
  if (status === 507) {
    return 'quota'
  }
  if (status >= 500) {
    return 'server'
  }
  return 'unknown'
}

export const toSyncError = (error: unknown): SyncError => {
  if (error instanceof SyncError) {
    return error
  }
  const candidate = error as { code?: unknown; name?: unknown; status?: unknown } | null
  if (candidate?.name === 'AbortError') {
    return new SyncError('aborted')
  }
  if (typeof candidate?.code === 'string' && Object.hasOwn(nativeCodes, candidate.code)) {
    return new SyncError(nativeCodes[candidate.code])
  }
  if (typeof candidate?.code === 'number') {
    return new SyncError(statusCode(candidate.code), candidate.code)
  }
  if (typeof candidate?.status === 'number') {
    return new SyncError(statusCode(candidate.status), candidate.status)
  }
  if (candidate?.name === 'OperationError' || candidate?.name === 'DataError') {
    return new SyncError('decrypt')
  }
  const message = error instanceof Error ? error.message : ''
  if (/failed to fetch|networkerror|network request failed/i.test(message)) {
    return new SyncError('network')
  }
  if (/certificate|ssl|trust anchor/i.test(message)) {
    return new SyncError('tls')
  }
  return new SyncError('unknown')
}

export const httpError = (status: number): SyncError =>
  new SyncError(statusCode(status), status)
