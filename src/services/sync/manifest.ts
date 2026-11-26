import { SyncError } from './errors.js'
import {
  SYNC_FORMAT,
  SYNC_VERSION,
  type SyncBaseline,
  type SyncDocumentVersion,
  type SyncManifest,
  type SyncSessionEntry,
} from './types.js'

export const EMPTY_HASH = '0'.repeat(64)

const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonical(item ?? null)).join(',')}]`
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(',')}}`
  }
  return 'null'
}

export const canonicalJson = (value: unknown): string => canonical(value)

export const hashText = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export const hashSyncPayload = (value: unknown): Promise<string> =>
  hashText(canonicalJson(value))

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const timestamp = (value: unknown): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new SyncError('corrupt')
  }
  return value
}

const hash = (value: unknown): string => {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
    throw new SyncError('corrupt')
  }
  return value
}

const unsafeId = (id: string) =>
  id === '__proto__' || id === 'prototype' || id === 'constructor'

const documentVersion = (value: unknown): SyncDocumentVersion => {
  if (!isRecord(value)) {
    throw new SyncError('corrupt')
  }
  return {
    version: typeof value.version === 'number' ? timestamp(value.version) : 1,
    updatedAt: timestamp(value.updatedAt),
    contentHash: hash(value.contentHash),
  }
}

const tombstones = (value: unknown): Record<string, number> => {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    throw new SyncError('corrupt')
  }
  const result: Record<string, number> = {}
  for (const [id, at] of Object.entries(value)) {
    if (!id || id.length > 256 || unsafeId(id)) {
      throw new SyncError('corrupt')
    }
    result[id] = timestamp(at)
  }
  return result
}

export const parseManifest = (value: unknown): SyncManifest => {
  if (!isRecord(value) || value.format !== SYNC_FORMAT || value.version !== SYNC_VERSION) {
    throw new SyncError('unsupported')
  }
  if (!isRecord(value.sessions)) {
    throw new SyncError('corrupt')
  }
  const entries = Object.entries(value.sessions)
  if (entries.length > 20_000) {
    throw new SyncError('tooLarge')
  }
  const sessions: Record<string, SyncSessionEntry> = {}
  for (const [id, entry] of entries) {
    if (
      !id ||
      id.length > 256 ||
      unsafeId(id) ||
      id.includes('/') ||
      id.includes('\\') ||
      id === '.' ||
      id === '..' ||
      !isRecord(entry) ||
      entry.id !== id
    ) {
      throw new SyncError('corrupt')
    }
    sessions[id] = {
      id,
      updatedAt: timestamp(entry.updatedAt),
      contentHash: hash(entry.contentHash),
    }
  }
  return {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    updatedAt: timestamp(value.updatedAt),
    sessions,
    deletedIds: tombstones(value.deletedIds),
    deletedFolderIds: tombstones(value.deletedFolderIds),
    folders: documentVersion(value.folders),
    prompts: documentVersion(value.prompts),
    settings: documentVersion(value.settings),
  }
}

export const emptyManifest = (now: number): SyncManifest => ({
  format: SYNC_FORMAT,
  version: SYNC_VERSION,
  updatedAt: now,
  sessions: {},
  deletedIds: {},
  deletedFolderIds: {},
  folders: { version: 1, updatedAt: now, contentHash: EMPTY_HASH },
  prompts: { version: 1, updatedAt: now, contentHash: EMPTY_HASH },
  settings: { version: 1, updatedAt: now, contentHash: EMPTY_HASH },
})

export const manifestSessionEntries = (sessions: Record<string, SyncSessionEntry>) =>
  Object.values(sessions).sort((a, b) => a.id.localeCompare(b.id))

export const baselineSessionHashes = (
  baseline: SyncBaseline | null
): Record<string, string> => baseline?.sessionHashes ?? {}
