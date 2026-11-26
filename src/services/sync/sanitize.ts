import type { FileAttachment, Session } from '../chat/types.js'
import { SyncError } from './errors.js'

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T

const DROPPED_KEYS = new Set([
  'accountfile',
  'accesstoken',
  'apikey',
  'authorization',
  'cookie',
  'cookies',
  'credential',
  'credentials',
  'customproviderid',
  'password',
  'passphrase',
  'refreshtoken',
  'secret',
  'serverid',
  'serveridscope',
])

const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

const shouldDrop = (key: string) =>
  UNSAFE_KEYS.has(key) || DROPPED_KEYS.has(key.replace(/[-_]/g, '').toLowerCase())

/**
 * 同步数据只保留内容字段，剔除凭据和本机/远端服务绑定字段。
 * 其余未知字段继续透传，以兼容 #28 等后续扩展。
 */
export const sanitizeSyncValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSyncValue(item)) as T
  }
  if (value === null || typeof value !== 'object') {
    return value
  }
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!shouldDrop(key)) {
      output[key] = sanitizeSyncValue(item)
    }
  }
  return output as T
}

/**
 * 同步会话清洗：
 * - 去掉设备相关的供应商 ID、文件服务端 ID 与官方账号文件引用；
 * - 去掉常见凭据字段，避免未知扩展把密钥带进同步 payload；
 * - 其余字段（含 #28 的人设绑定等未知扩展）原样保留，避免重复定义类型。
 */
export const sanitizeSession = (session: Session): Session => {
  const clean = sanitizeSyncValue(clone(session))
  clean.messages = clean.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    return {
      ...message,
      files: message.files.map((file): FileAttachment => ({ ...file, serverId: null })),
    }
  })
  return clean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/** 远端 JSON 只做结构校验，随后仍走 sanitizeSession 清洗。 */
export const readRemoteSession = (value: unknown): Session => {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 256 ||
    UNSAFE_KEYS.has(value.id) ||
    value.id.includes('/') ||
    value.id.includes('\\') ||
    value.id === '.' ||
    value.id === '..' ||
    typeof value.title !== 'string' ||
    !finite(value.createdAt) ||
    !finite(value.updatedAt) ||
    !Array.isArray(value.messages)
  ) {
    throw new SyncError('corrupt')
  }
  for (const message of value.messages) {
    if (
      !isRecord(message) ||
      typeof message.id !== 'string' ||
      (message.role !== 'user' && message.role !== 'assistant') ||
      !finite(message.createdAt)
    ) {
      throw new SyncError('corrupt')
    }
    if (message.role === 'user' && !Array.isArray(message.files)) {
      throw new SyncError('corrupt')
    }
    if (message.role === 'user') {
      for (const file of message.files as unknown[]) {
        if (
          !isRecord(file) ||
          typeof file.id !== 'string' ||
          !file.id ||
          file.id.length > 256 ||
          UNSAFE_KEYS.has(file.id) ||
          file.id.includes('/') ||
          file.id.includes('\\') ||
          file.id === '.' ||
          file.id === '..'
        ) {
          throw new SyncError('corrupt')
        }
      }
    }
  }
  return sanitizeSession(value as unknown as Session)
}
