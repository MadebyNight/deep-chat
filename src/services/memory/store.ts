import { createId } from '../../utils/id.js'
import * as db from '../chat/db.js'
import { buildMemoryPrompt } from './retrieval.js'
import type { MemoryEntry } from './types.js'
import {
  memoryFingerprint,
  MemoryValidationError,
  normalizeMemoryTags,
  validateMemoryContent,
} from './validation.js'

export type MemoryRepository = {
  load(): Promise<MemoryEntry[]>
  save(entry: MemoryEntry): Promise<void>
  remove(id: string): Promise<void>
  clear(): Promise<void>
}

export const indexedDbMemoryRepository: MemoryRepository = {
  load: db.loadMemoryEntries,
  save: db.putMemoryEntry,
  remove: db.deleteMemoryEntry,
  clear: db.clearMemoryEntries,
}

type StoreOptions = {
  repository?: MemoryRepository
  now?: number
}

const repository = (options: StoreOptions) => options.repository ?? indexedDbMemoryRepository
const now = (options: StoreOptions) => options.now ?? Date.now()

const activeEntries = async (options: StoreOptions) => {
  const entries = await repository(options).load()
  const current = now(options)
  const expired = entries.filter((entry) => (entry.expiresAt ?? Infinity) <= current)
  if (expired.length > 0) {
    await Promise.all(
      expired.map((entry) =>
        repository(options)
          .remove(entry.id)
          .catch(() => undefined)
      )
    )
  }
  return entries.filter((entry) => (entry.expiresAt ?? Infinity) > current)
}

export const listMemories = async (options: StoreOptions = {}): Promise<MemoryEntry[]> =>
  (await activeEntries(options)).sort(
    (a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id)
  )

export type RememberMemoryOptions = StoreOptions & {
  tags?: readonly string[]
  sourceSessionId?: string | null
  expiresAt?: number
}

export type RememberMemoryResult = {
  entry: MemoryEntry
  duplicate: boolean
}

/** 新增或合并同指纹记忆；更新时保留锚点 id 和最早的创建时间。 */
export const rememberMemory = async (
  value: string,
  options: RememberMemoryOptions = {}
): Promise<RememberMemoryResult> => {
  const content = validateMemoryContent(value)
  const tags = normalizeMemoryTags(options.tags)
  const fingerprint = memoryFingerprint(content)
  const entries = await activeEntries(options)
  const existing = entries.find((entry) => memoryFingerprint(entry.content) === fingerprint)
  if (existing) {
    const mergedTags = normalizeMemoryTags([...existing.tags, ...tags])
    const changed =
      existing.content !== content ||
      mergedTags.length !== existing.tags.length ||
      mergedTags.some((tag, index) => tag !== existing.tags[index])
    if (!changed) {
      return { entry: existing, duplicate: true }
    }
    const updated: MemoryEntry = {
      ...existing,
      content,
      tags: mergedTags,
      sourceSessionId: existing.sourceSessionId ?? options.sourceSessionId ?? null,
      updatedAt: now(options),
      ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
    }
    await repository(options).save(updated)
    return { entry: updated, duplicate: true }
  }
  const timestamp = now(options)
  const entry: MemoryEntry = {
    id: createId(),
    content,
    tags,
    sourceSessionId: options.sourceSessionId ?? null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
  }
  await repository(options).save(entry)
  return { entry, duplicate: false }
}

export type UpdateMemoryOptions = StoreOptions & {
  tags?: readonly string[]
}

export const updateMemory = async (
  id: string,
  value: string,
  options: UpdateMemoryOptions = {}
): Promise<MemoryEntry> => {
  const content = validateMemoryContent(value)
  const fingerprint = memoryFingerprint(content)
  const entries = await activeEntries(options)
  const existing = entries.find((entry) => entry.id === id)
  if (!existing) {
    throw new MemoryValidationError('missing')
  }
  if (
    entries.some((entry) => entry.id !== id && memoryFingerprint(entry.content) === fingerprint)
  ) {
    throw new MemoryValidationError('duplicate')
  }
  const tags = options.tags === undefined ? existing.tags : normalizeMemoryTags(options.tags)
  const updated: MemoryEntry = {
    ...existing,
    content,
    tags,
    updatedAt: now(options),
  }
  await repository(options).save(updated)
  return updated
}

export const forgetMemory = (id: string, options: StoreOptions = {}): Promise<void> =>
  repository(options).remove(id)

export const clearMemories = (options: StoreOptions = {}): Promise<void> =>
  repository(options).clear()

/** 发送前读取本机记忆并组装预算内的注入文本；调用方负责静默降级。 */
export const loadMemoryPrompt = async (
  query: string,
  options: StoreOptions & { budget?: number } = {}
): Promise<string | null> =>
  buildMemoryPrompt(await activeEntries(options), query, {
    now: now(options),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
  })
