import type { Folder, Session } from '../chat/types.js'

export const SYNC_FORMAT = 'deepchat.sync'
export const SYNC_VERSION = 1

export type SyncSessionEntry = {
  id: string
  updatedAt: number
  contentHash: string
}

export type SyncDocumentVersion = {
  version: number
  updatedAt: number
  contentHash: string
}

export type SyncManifest = {
  format: typeof SYNC_FORMAT
  version: typeof SYNC_VERSION
  updatedAt: number
  sessions: Record<string, SyncSessionEntry>
  /** 会话墓碑：id → 删除时间。 */
  deletedIds: Record<string, number>
  /** 分组墓碑，避免其他设备重新带回已删除的分组。 */
  deletedFolderIds: Record<string, number>
  folders: SyncDocumentVersion
  prompts: SyncDocumentVersion
  settings: SyncDocumentVersion
}

export type SyncFoldersDocument = {
  version: 1
  updatedAt: number
  folders: Folder[]
}

/**
 * 提示词按原始 JSON 透传，避免与 #28 的 PromptPreset 扩展字段重复定义。
 * 只校验 id/title/body，其余字段原样保留。
 */
export type SyncPromptsDocument = {
  version: 1
  updatedAt: number
  presets: Record<string, unknown>[]
  selectedId: string | null
}

/** 仅同步可跨设备的非敏感偏好；语言、主题、音色等保持本机。 */
export type SyncPortableSettings = {
  thinking?: boolean
  search?: boolean
  autoCollapseThinking?: boolean
  autoCompactContext?: boolean
  chatFontSize?: number | null
}

export type SyncSettingsDocument = {
  version: 1
  updatedAt: number
  values: SyncPortableSettings
}

export type SyncBaseline = {
  manifest: SyncManifest
  sessionHashes: Record<string, string>
  folders: Folder[]
  settings: SyncPortableSettings
  promptsHash: string
  /** 提示词逐项哈希，用于识别本机/远端删除与编辑。 */
  promptHashes: Record<string, string>
  promptSelectedId: string | null
}

export type SyncLocalState = {
  version: 1
  baseline: SyncBaseline | null
  lastSyncAt: number | null
  deviceId: string
  /** 已成功上传的附件 id；仅本地元数据，不含文件内容或凭据。 */
  uploadedFileIds: string[]
}

export type WebDavConfig = {
  url: string
  username: string
  password: string
  passphrase: string
}

export type AttachmentPolicy = 'metadata' | 'images'

export type SyncPreferences = {
  autoSync: boolean
  attachmentPolicy: AttachmentPolicy
}

export type RemoteRead = { text: string; etag?: string }
export type RemoteWrite = { etag?: string }
export type RemoteWriteCondition = { etag?: string; ifNoneMatch?: boolean }

/** 远端协议抽象；本期只实现 WebDAV，S3 可复用同一接口。 */
export type RemoteSyncProvider = {
  readonly kind: 'webdav'
  test(signal: AbortSignal): Promise<void>
  ensureCollection(path: string, signal: AbortSignal): Promise<void>
  read(path: string, signal: AbortSignal): Promise<RemoteRead | null>
  write(
    path: string,
    text: string,
    condition: RemoteWriteCondition,
    signal: AbortSignal
  ): Promise<RemoteWrite>
  delete(path: string, signal: AbortSignal): Promise<void>
}

export type SyncedSession = {
  session: Session
  updatedAt: number
  contentHash: string
}

export type SyncResult = {
  uploaded: number
  downloaded: number
  deleted: number
  conflicts: number
  lastSyncAt: number
}

export type SyncRunMode = 'manual' | 'auto'
