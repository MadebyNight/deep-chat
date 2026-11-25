import type { TranslationMessage } from '../i18n/index.js'

export const SHARED_INTAKE_MAX_FILES = 10
export const SHARED_INTAKE_MAX_FILE_BYTES = 32 * 1024 * 1024
export const SHARED_INTAKE_MAX_TOTAL_BYTES = 64 * 1024 * 1024
export const SHARED_INTAKE_MAX_TEXT_CHARS = 64 * 1024

export type ShortcutAction = 'new' | 'voice' | 'camera'

export type SharedIntakeFile = {
  uri: string
  name: string
  mimeType: string
  size: number
}

export type SharedIntakeErrorCode =
  | 'TOO_MANY_FILES'
  | 'FILE_TOO_LARGE'
  | 'TOTAL_TOO_LARGE'
  | 'TEXT_TOO_LONG'
  | 'UNSUPPORTED'
  | 'READ_FAILED'

export type NativeIntake =
  | {
      id: string
      kind: 'share' | 'process-text'
      text: string
      files: SharedIntakeFile[]
    }
  | { id: string; kind: 'shortcut'; shortcut: ShortcutAction }
  | { id: string; kind: 'error'; error: SharedIntakeErrorCode }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isSafeId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value)

const isSafeFileName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= 128 &&
  !value.includes('\u0000') &&
  !/[/\\]/.test(value) &&
  value !== '.' &&
  value !== '..'

const isSafeMimeType = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 128 &&
  /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/.test(value)

const isSharedIntakeUri = (value: string) => {
  if (value.length > 512) {
    return false
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) {
    return false
  }
  let path: string
  try {
    path = decodeURIComponent(url.pathname)
  } catch {
    return false
  }
  if (path.includes('\u0000') || path.includes('\\')) {
    return false
  }
  const segments = path.split('/')
  if (segments.includes('.') || segments.includes('..')) {
    return false
  }
  const index = segments.indexOf('shared_intake')
  return index > 0 && segments[index - 1] === 'cache' && index < segments.length - 2
}

const errorCode = (value: unknown): SharedIntakeErrorCode =>
  value === 'TOO_MANY_FILES' ||
  value === 'FILE_TOO_LARGE' ||
  value === 'TOTAL_TOO_LARGE' ||
  value === 'TEXT_TOO_LONG' ||
  value === 'UNSUPPORTED'
    ? value
    : 'READ_FAILED'

const parseFile = (value: unknown): SharedIntakeFile | null => {
  if (!isRecord(value)) {
    return null
  }
  if (
    typeof value.uri !== 'string' ||
    !isSharedIntakeUri(value.uri) ||
    !isSafeFileName(value.name) ||
    !isSafeMimeType(value.mimeType) ||
    typeof value.size !== 'number' ||
    !Number.isSafeInteger(value.size) ||
    value.size < 0 ||
    value.size > SHARED_INTAKE_MAX_FILE_BYTES
  ) {
    return null
  }
  return {
    uri: value.uri,
    name: value.name,
    mimeType: value.mimeType,
    size: value.size,
  }
}

export const parseIntake = (value: unknown): NativeIntake | null => {
  if (!isRecord(value) || !isSafeId(value.id)) {
    return null
  }
  if (value.kind === 'shortcut') {
    if (value.shortcut !== 'new' && value.shortcut !== 'voice' && value.shortcut !== 'camera') {
      return null
    }
    return { id: value.id, kind: 'shortcut', shortcut: value.shortcut }
  }
  if (value.kind === 'error') {
    return { id: value.id, kind: 'error', error: errorCode(value.error) }
  }
  if (value.kind !== 'share' && value.kind !== 'process-text') {
    return null
  }
  if (
    typeof value.text !== 'string' ||
    value.text.length > SHARED_INTAKE_MAX_TEXT_CHARS ||
    !Array.isArray(value.files) ||
    value.files.length > SHARED_INTAKE_MAX_FILES
  ) {
    return null
  }
  const files: SharedIntakeFile[] = []
  let total = 0
  for (const entry of value.files) {
    const file = parseFile(entry)
    if (!file) {
      return null
    }
    total += file.size
    if (total > SHARED_INTAKE_MAX_TOTAL_BYTES) {
      return null
    }
    files.push(file)
  }
  if (value.kind === 'process-text') {
    if (!value.text.trim() || files.length > 0) {
      return null
    }
  } else if (!value.text.trim() && files.length === 0) {
    return null
  }
  return { id: value.id, kind: value.kind, text: value.text, files }
}

export const mergeDraftText = (current: string, incoming: string) => {
  if (!incoming.trim()) {
    return current.replace(/\s+$/u, '')
  }
  const left = current.replace(/\s+$/u, '')
  const right = left ? incoming.replace(/^\n+/u, '') : incoming
  return left && right ? `${left}\n${right}` : left || right
}

export const describeIntakeError = (code: SharedIntakeErrorCode): TranslationMessage => {
  if (code === 'TOO_MANY_FILES') {
    return { key: 'uploadMaxFiles', params: { count: SHARED_INTAKE_MAX_FILES } }
  }
  if (code === 'FILE_TOO_LARGE') {
    return {
      key: 'uploadMaxMBSize',
      params: { size: SHARED_INTAKE_MAX_FILE_BYTES / (1024 * 1024) },
    }
  }
  if (code === 'TOTAL_TOO_LARGE') {
    return {
      key: 'shareIntakeTotalTooLarge',
      params: { size: SHARED_INTAKE_MAX_TOTAL_BYTES / (1024 * 1024) },
    }
  }
  if (code === 'TEXT_TOO_LONG') {
    return {
      key: 'shareIntakeTextTooLong',
      params: { size: SHARED_INTAKE_MAX_TEXT_CHARS / 1024 },
    }
  }
  if (code === 'UNSUPPORTED') {
    return { key: 'uploadUnsupportedFormat' }
  }
  return { key: 'shareIntakeReadFailed' }
}
