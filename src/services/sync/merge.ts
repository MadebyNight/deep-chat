import type { Folder, Session } from '../chat/types.js'
import { hashSyncPayload } from './manifest.js'
import type {
  SyncBaseline,
  SyncFoldersDocument,
  SyncManifest,
  SyncPortableSettings,
  SyncPromptsDocument,
  SyncSessionEntry,
  SyncSettingsDocument,
  SyncedSession,
} from './types.js'

const TOMBSTONE_RETENTION_MS = 180 * 24 * 60 * 60 * 1000

type SessionMergeOptions = {
  local: Map<string, SyncedSession>
  remote: Map<string, SyncedSession>
  remoteManifest: SyncManifest | null
  baseline: SyncBaseline | null
  now: number
  conflictSuffix: string
}

export type SessionMergeResult = {
  imports: SyncedSession[]
  uploads: SyncedSession[]
  deletes: string[]
  localSessions: Map<string, SyncedSession>
  remoteSessions: Record<string, SyncSessionEntry>
  tombstones: Record<string, number>
  conflicts: number
}

const maxTombstone = (a: number | undefined, b: number | undefined) => Math.max(a ?? 0, b ?? 0)

export const pruneTombstones = (value: Record<string, number>, now: number) =>
  Object.fromEntries(
    Object.entries(value).filter(([, at]) => now - at <= TOMBSTONE_RETENTION_MS)
  )

const entryOf = (value: SyncedSession): SyncSessionEntry => ({
  id: value.session.id,
  updatedAt: value.updatedAt,
  contentHash: value.contentHash,
})

const conflictId = (source: SyncedSession) =>
  `${source.session.id}~conflict-${source.contentHash.slice(0, 12)}`

const makeConflictSession = async (
  source: SyncedSession,
  suffix: string,
  now: number,
  known: Map<string, SyncedSession>
): Promise<SyncedSession> => {
  const id = conflictId(source)
  const existing = known.get(id)
  if (existing) {
    return existing
  }
  const session: Session = {
    ...source.session,
    id,
    title: source.session.title ? `${source.session.title}${suffix}` : suffix.trim(),
    updatedAt: now,
  }
  return { session, updatedAt: now, contentHash: await hashSyncPayload(session) }
}

/**
 * 会话合并以“上次成功同步的本机哈希”和“上次远端 manifest”为基线：
 * - 单边变更直接上传/导入；
 * - 双边变更保留较新版本，另一方生成确定性的冲突副本；
 * - 删除与编辑冲突时保留墓碑，同时把编辑内容留成冲突副本。
 */
export const mergeSessions = async ({
  local,
  remote,
  remoteManifest,
  baseline,
  now,
  conflictSuffix,
}: SessionMergeOptions): Promise<SessionMergeResult> => {
  const baseSessions = baseline?.manifest.sessions ?? {}
  const baseHashes = baseline?.sessionHashes ?? {}
  const remoteEntries = remoteManifest?.sessions ?? {}
  const tombstones: Record<string, number> = { ...(remoteManifest?.deletedIds ?? {}) }
  for (const [id, at] of Object.entries(baseline?.manifest.deletedIds ?? {})) {
    tombstones[id] = maxTombstone(tombstones[id], at)
  }

  const localSessions = new Map(local)
  const remoteSessions = new Map(remote)
  const nextRemote = new Map(remoteSessions)
  const deletes = new Set<string>()
  const imports: SyncedSession[] = []
  const uploads: SyncedSession[] = []
  let conflicts = 0

  for (const id of Object.keys(baseSessions)) {
    if (!localSessions.has(id) && tombstones[id] === undefined) {
      tombstones[id] = now
    }
  }

  const ids = new Set([
    ...localSessions.keys(),
    ...remoteSessions.keys(),
    ...Object.keys(remoteEntries),
    ...Object.keys(baseSessions),
    ...Object.keys(tombstones),
  ])

  const rememberLocalConflict = async (source: SyncedSession) => {
    const copy = await makeConflictSession(source, conflictSuffix, now, localSessions)
    if (!localSessions.has(copy.session.id)) {
      localSessions.set(copy.session.id, copy)
      conflicts += 1
    }
    if (!nextRemote.has(copy.session.id)) {
      nextRemote.set(copy.session.id, copy)
      uploads.push(copy)
    }
  }

  const rememberRemoteConflict = async (source: SyncedSession) => {
    const copy = await makeConflictSession(source, conflictSuffix, now, localSessions)
    if (!localSessions.has(copy.session.id)) {
      localSessions.set(copy.session.id, copy)
      imports.push(copy)
      conflicts += 1
    }
    if (!nextRemote.has(copy.session.id)) {
      nextRemote.set(copy.session.id, copy)
      uploads.push(copy)
    }
  }

  for (const id of ids) {
    const localValue = localSessions.get(id)
    const remoteValue = remoteSessions.get(id)
    const baseEntry = baseSessions[id]
    const tombstone = tombstones[id]
    const localUnchanged =
      !!baseEntry && !!localValue && baseHashes[id] === localValue.contentHash
    const remoteUnchanged =
      !!baseEntry && !!remoteValue && baseEntry.contentHash === remoteValue.contentHash

    if (tombstone !== undefined) {
      if (localValue) {
        if (localUnchanged) {
          deletes.add(id)
          localSessions.delete(id)
        } else {
          await rememberLocalConflict(localValue)
          deletes.add(id)
          localSessions.delete(id)
        }
      } else if (remoteValue && !remoteUnchanged) {
        await rememberRemoteConflict(remoteValue)
      }
      nextRemote.delete(id)
      continue
    }

    if (localValue && remoteValue) {
      if (localValue.contentHash === remoteValue.contentHash) {
        continue
      }
      if (localUnchanged && !remoteUnchanged) {
        localSessions.set(id, remoteValue)
        nextRemote.set(id, remoteValue)
        imports.push(remoteValue)
        continue
      }
      if (!localUnchanged && remoteUnchanged) {
        uploads.push(localValue)
        nextRemote.set(id, localValue)
        continue
      }
      if (!baseEntry) {
        // 两侧同时出现同一 id 且内容不同：视为并发创建，保留冲突副本。
      } else if (!localUnchanged || !remoteUnchanged) {
        // 两侧都改过：进入下面的冲突处理。
      } else {
        // 基线哈希与两侧都不同，仍按冲突处理。
      }
      if (localValue.updatedAt >= remoteValue.updatedAt) {
        await rememberRemoteConflict(remoteValue)
        uploads.push(localValue)
        nextRemote.set(id, localValue)
      } else {
        localSessions.set(id, remoteValue)
        imports.push(remoteValue)
        nextRemote.set(id, remoteValue)
        await rememberLocalConflict(localValue)
      }
      continue
    }

    if (localValue) {
      if (baseEntry) {
        // 远端没有墓碑却移除了会话，按远端删除处理；本机有编辑时保留副本。
        tombstones[id] = maxTombstone(tombstones[id], now)
        if (localUnchanged) {
          deletes.add(id)
          localSessions.delete(id)
        } else {
          await rememberLocalConflict(localValue)
          deletes.add(id)
          localSessions.delete(id)
        }
      } else {
        uploads.push(localValue)
        nextRemote.set(id, localValue)
      }
      continue
    }

    if (remoteValue) {
      if (baseEntry) {
        tombstones[id] = maxTombstone(tombstones[id], now)
        if (!remoteUnchanged) {
          await rememberRemoteConflict(remoteValue)
        }
        nextRemote.delete(id)
      } else {
        localSessions.set(id, remoteValue)
        imports.push(remoteValue)
      }
      continue
    }

    if (baseEntry) {
      tombstones[id] = maxTombstone(tombstones[id], now)
    }
  }

  for (const id of deletes) {
    localSessions.delete(id)
    nextRemote.delete(id)
  }
  for (const id of Object.keys(tombstones)) {
    nextRemote.delete(id)
  }

  return {
    imports,
    uploads,
    deletes: [...deletes],
    localSessions,
    remoteSessions: Object.fromEntries(
      [...nextRemote].map(([id, value]) => [id, entryOf(value)])
    ),
    tombstones: pruneTombstones(tombstones, now),
    conflicts,
  }
}

export type FolderMergeResult = {
  folders: Folder[]
  deletedFolderIds: string[]
  tombstones: Record<string, number>
  write: boolean
}

/** 分组是轻量元数据：按 id 合并，同 id 冲突保留本机名称；删除用墓碑传播。 */
export const mergeFolders = ({
  local,
  remote,
  remoteManifest,
  baseline,
  now,
}: {
  local: Folder[]
  remote: Folder[]
  remoteManifest: SyncManifest | null
  baseline: SyncBaseline | null
  now: number
}): FolderMergeResult => {
  const localMap = new Map(local.map((folder) => [folder.id, folder]))
  const remoteMap = new Map(remote.map((folder) => [folder.id, folder]))
  const baseMap = new Map((baseline?.folders ?? []).map((folder) => [folder.id, folder]))
  const tombstones: Record<string, number> = { ...(remoteManifest?.deletedFolderIds ?? {}) }
  for (const [id, at] of Object.entries(baseline?.manifest.deletedFolderIds ?? {})) {
    tombstones[id] = maxTombstone(tombstones[id], at)
  }
  for (const id of baseMap.keys()) {
    if (!localMap.has(id) && tombstones[id] === undefined) {
      tombstones[id] = now
    }
  }
  const result = new Map<string, Folder>()
  for (const [id, folder] of remoteMap) {
    if (tombstones[id] === undefined) {
      result.set(id, folder)
    }
  }
  for (const [id, folder] of localMap) {
    const remoteFolder = remoteMap.get(id)
    const baseFolder = baseMap.get(id)
    const localChanged = !baseFolder || JSON.stringify(folder) !== JSON.stringify(baseFolder)
    const remoteChanged =
      !!baseFolder && !!remoteFolder && JSON.stringify(remoteFolder) !== JSON.stringify(baseFolder)
    const remoteTombstone = tombstones[id] !== undefined
    if (remoteTombstone) {
      if (localChanged) {
        result.set(id, folder)
      } else {
        result.delete(id)
      }
      continue
    }
    if (!remoteFolder) {
      result.set(id, folder)
    } else if (localChanged && !remoteChanged) {
      result.set(id, folder)
    } else if (!localChanged && remoteChanged) {
      result.set(id, remoteFolder)
    } else {
      result.set(id, localChanged ? folder : remoteFolder)
    }
  }
  const folders = [...result.values()].sort(
    (a, b) => a.order - b.order || a.name.localeCompare(b.name)
  )
  const deletedFolderIds = Object.keys(tombstones).filter((id) => !result.has(id))
  return {
    folders,
    deletedFolderIds,
    tombstones: pruneTombstones(
      Object.fromEntries(deletedFolderIds.map((id) => [id, tombstones[id]])),
      now
    ),
    write: JSON.stringify(folders) !== JSON.stringify(remote),
  }
}

export type PromptsMergeResult = {
  document: SyncPromptsDocument
  write: boolean
  conflicts: number
}

const isPrompt = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as Record<string, unknown>).id === 'string' &&
  !!(value as Record<string, unknown>).id &&
  typeof (value as Record<string, unknown>).title === 'string' &&
  typeof (value as Record<string, unknown>).body === 'string'

const cleanPrompts = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isPrompt).slice(0, 200) : []

const promptMap = async (value: unknown) => {
  const entries = await Promise.all(
    cleanPrompts(value).map(async (item) => {
      const id = String(item.id)
      return [id, { item, hash: await hashSyncPayload(item) }] as const
    })
  )
  return new Map(entries)
}

export const promptFingerprints = async (
  presets: Record<string, unknown>[]
): Promise<Record<string, string>> => {
  const entries = await Promise.all(
    cleanPrompts(presets).map(async (item) => [
      String(item.id),
      await hashSyncPayload(item),
    ] as const)
  )
  return Object.fromEntries(entries)
}

/**
 * 提示词按 id 合并。删除需要以逐项基线为准；删除与编辑冲突时，
 * 编辑内容保留为确定性冲突副本，原 id 继续保持删除状态。
 */
export const mergePrompts = async ({
  local,
  remote,
  baseline,
  localHash,
  remoteHash,
  now,
  conflictSuffix,
}: {
  local: SyncPromptsDocument
  remote: SyncPromptsDocument | null
  baseline: SyncBaseline | null
  localHash: string
  remoteHash: string
  now: number
  conflictSuffix: string
}): Promise<PromptsMergeResult> => {
  if (!remote) {
    return { document: { ...local, updatedAt: now }, write: true, conflicts: 0 }
  }
  if (baseline) {
    const localChanged = localHash !== baseline.promptsHash
    const remoteChanged = remoteHash !== baseline.manifest.prompts.contentHash
    if (!localChanged && remoteChanged) {
      return { document: remote, write: false, conflicts: 0 }
    }
    if (localChanged && !remoteChanged) {
      return { document: { ...local, updatedAt: now }, write: true, conflicts: 0 }
    }
  }
  const [localMap, remoteMap] = await Promise.all([
    promptMap(local.presets),
    promptMap(remote.presets),
  ])
  const baseHashes = baseline?.promptHashes ?? {}
  const result = new Map<string, Record<string, unknown>>()
  let conflicts = 0

  const addConflict = (
    id: string,
    remoteItem: Record<string, unknown>,
    hash: string
  ) => {
    const copyId = `${id}~conflict-${hash.slice(0, 12)}`
    if (localMap.has(copyId) || remoteMap.has(copyId)) {
      return
    }
    result.set(copyId, {
      ...remoteItem,
      id: copyId,
      title: typeof remoteItem.title === 'string'
        ? `${remoteItem.title}${conflictSuffix}`
        : conflictSuffix.trim(),
      createdAt:
        typeof remoteItem.createdAt === 'number' ? remoteItem.createdAt : now,
    })
    conflicts += 1
  }

  const ids = new Set([
    ...Object.keys(baseHashes),
    ...localMap.keys(),
    ...remoteMap.keys(),
  ])
  for (const id of ids) {
    const localEntry = localMap.get(id)
    const remoteEntry = remoteMap.get(id)
    const baseHash = baseHashes[id]
    const localChanged =
      !!localEntry && (!baseHash || localEntry.hash !== baseHash)
    const remoteChanged =
      !!remoteEntry && (!baseHash || remoteEntry.hash !== baseHash)

    if (localEntry && remoteEntry) {
      if (localEntry.hash === remoteEntry.hash) {
        result.set(id, remoteEntry.item)
        continue
      }
      if (!baseHash) {
        result.set(id, localEntry.item)
        addConflict(id, remoteEntry.item, remoteEntry.hash)
        continue
      }
      if (localChanged && !remoteChanged) {
        result.set(id, localEntry.item)
        continue
      }
      if (!localChanged && remoteChanged) {
        result.set(id, remoteEntry.item)
        continue
      }
      result.set(id, localEntry.item)
      addConflict(id, remoteEntry.item, remoteEntry.hash)
      continue
    }

    if (localEntry) {
      if (!baseHash) {
        result.set(id, localEntry.item)
      } else if (localChanged) {
        addConflict(id, localEntry.item, localEntry.hash)
      }
      continue
    }

    if (remoteEntry) {
      if (!baseHash) {
        result.set(id, remoteEntry.item)
      } else if (remoteChanged) {
        addConflict(id, remoteEntry.item, remoteEntry.hash)
      }
    }
  }

  const presets = [...result.values()]
  const baseSelected = baseline?.promptSelectedId ?? null
  const localSelectionChanged = local.selectedId !== baseSelected
  const remoteSelectionChanged = remote.selectedId !== baseSelected
  let selectedId =
    localSelectionChanged || !remoteSelectionChanged
      ? local.selectedId
      : remote.selectedId
  if (typeof selectedId !== 'string' || !result.has(selectedId)) {
    if (typeof remote.selectedId === 'string' && result.has(remote.selectedId)) {
      selectedId = remote.selectedId
    } else if (typeof local.selectedId === 'string' && result.has(local.selectedId)) {
      selectedId = local.selectedId
    } else {
      selectedId = null
    }
  }
  const document: SyncPromptsDocument = {
    version: 1,
    updatedAt: now,
    presets,
    selectedId,
  }
  return {
    document,
    write: JSON.stringify(presets) !== JSON.stringify(remote.presets) ||
      selectedId !== remote.selectedId,
    conflicts,
  }
}

const portableSettings = (value: unknown): SyncPortableSettings => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }
  const source = value as Record<string, unknown>
  const result: SyncPortableSettings = {}
  for (const key of [
    'thinking',
    'search',
    'autoCollapseThinking',
    'autoCompactContext',
  ] as const) {
    if (typeof source[key] === 'boolean') {
      result[key] = source[key]
    }
  }
  if (
    source.chatFontSize === null ||
    (typeof source.chatFontSize === 'number' &&
      Number.isInteger(source.chatFontSize) &&
      source.chatFontSize >= 14 &&
      source.chatFontSize <= 22)
  ) {
    result.chatFontSize = source.chatFontSize as number | null
  }
  return result
}

/** 设置按字段合并：本机改过的字段优先，其余字段接受远端值。 */
export const mergeSettings = ({
  local,
  remote,
  baseline,
  now,
}: {
  local: SyncPortableSettings
  remote: SyncSettingsDocument | null
  baseline: SyncBaseline | null
  now: number
}): { document: SyncSettingsDocument; write: boolean } => {
  const remoteValues = portableSettings(remote?.values)
  const baseValues = portableSettings(baseline?.settings)
  const localValues = portableSettings(local)
  const result: SyncPortableSettings = { ...remoteValues }
  const keys = new Set([
    ...Object.keys(localValues),
    ...Object.keys(remoteValues),
  ] as (keyof SyncPortableSettings)[])
  for (const key of keys) {
    if (JSON.stringify(localValues[key]) !== JSON.stringify(baseValues[key])) {
      if (localValues[key] === undefined) {
        result[key] = undefined
      } else {
        result[key] = localValues[key] as never
      }
    }
  }
  const document: SyncSettingsDocument = { version: 1, updatedAt: now, values: result }
  return {
    document,
    write: JSON.stringify(result) !== JSON.stringify(remoteValues),
  }
}

export const folderDocument = (folders: Folder[], now: number): SyncFoldersDocument => ({
  version: 1,
  updatedAt: now,
  folders,
})
