import { translate } from '../../i18n/index.js'
import type { FileAttachment, Folder, Session } from '../chat/types.js'
import * as db from '../chat/db.js'
import {
  acquireChatStorageLock,
  flushChatForSync,
  refreshChatAfterSync,
  releaseChatStorageLock,
} from '../chat/store.js'
import {
  setAutoCollapseThinking,
  setAutoCompactContext,
  setChatFontSize,
  setPrompts,
  setSearch,
  setThinking,
  useSettings,
} from '../settings.js'
import { decodeBase64, encodeBase64, SyncCipher } from './crypto.js'
import { SyncError, toSyncError } from './errors.js'
import { hashSyncPayload, parseManifest } from './manifest.js'
import {
  folderDocument,
  mergeFolders,
  mergePrompts,
  mergeSessions,
  mergeSettings,
  promptFingerprints,
} from './merge.js'
import { readRemoteSession, sanitizeSession, sanitizeSyncValue } from './sanitize.js'
import {
  readSyncPreferences,
  readSyncState,
  readWebDavConfig,
  setSyncError,
  setSyncPhase,
  setSyncSuccess,
  useSyncStatus,
  writeSyncState,
  type SyncPhase,
} from './state.js'
import {
  SYNC_FORMAT,
  SYNC_VERSION,
  type AttachmentPolicy,
  type RemoteSyncProvider,
  type RemoteRead,
  type SyncFoldersDocument,
  type SyncManifest,
  type SyncPortableSettings,
  type SyncPreferences,
  type SyncPromptsDocument,
  type SyncResult,
  type SyncRunMode,
  type SyncSettingsDocument,
  type SyncedSession,
  type WebDavConfig,
} from './types.js'
import { WebDavClient, validateWebDavConfig } from './webdav.js'

const MANIFEST_PATH = 'manifest.json'
const FOLDERS_PATH = 'folders.json'
const PROMPTS_PATH = 'prompts.json'
const SETTINGS_PATH = 'settings.json'
const SESSION_DIR = 'sessions'
const BLOB_DIR = 'blobs'
const MAX_ATTACHMENT_BYTES = 1_500_000
const MAX_ATTACHMENT_TOTAL = 24_000_000
const MAX_SESSION_BYTES = 16_000_000
const AUTO_SYNC_INTERVAL = 5 * 60_000
const AUTO_BACKGROUND_INTERVAL = 60_000
const SYNC_ATTEMPTS = 3

type DocumentRead<T> = { value: T; etag?: string }

const openRemoteDocument = <T>(
  text: string,
  passphrase: string,
  allowPlaintextMigration: boolean
) =>
  allowPlaintextMigration
    ? SyncCipher.openForInitialMigration<T>(text, passphrase)
    : SyncCipher.open<T>(text, passphrase)

const EMPTY_PROMPTS: SyncPromptsDocument = {
  version: 1,
  updatedAt: 0,
  presets: [],
  selectedId: null,
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const promptItem = (value: unknown): value is Record<string, unknown> =>
  isRecord(value) &&
  typeof value.id === 'string' &&
  !!value.id &&
  value.id.length <= 256 &&
  typeof value.title === 'string' &&
  typeof value.body === 'string'

const sessionPath = (id: string) => `${SESSION_DIR}/${id}.json`
const blobPath = (id: string) => `${BLOB_DIR}/${id}.json`

const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T, index: number) => Promise<R>
): Promise<R[]> => {
  const output = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next
      next += 1
      output[index] = await run(items[index], index)
    }
  })
  await Promise.all(workers)
  return output
}

const readOptionalDocument = async <T>(
  provider: RemoteSyncProvider,
  path: string,
  passphrase: string,
  parse: (value: unknown) => T,
  allowPlaintextMigration: boolean,
  signal: AbortSignal
): Promise<DocumentRead<T> | null> => {
  const raw = await provider.read(path, signal)
  if (!raw) {
    return null
  }
  const opened = await openRemoteDocument<unknown>(
    raw.text,
    passphrase,
    allowPlaintextMigration
  )
  return {
    value: parse(opened.value),
    ...(raw.etag ? { etag: raw.etag } : {}),
  }
}

const parseFoldersDocument = (value: unknown): SyncFoldersDocument => {
  if (!isRecord(value) || value.version !== 1 || !finite(value.updatedAt)) {
    throw new SyncError('corrupt')
  }
  if (
    !Array.isArray(value.folders) ||
    !value.folders.every(
      (folder) =>
        isRecord(folder) &&
        typeof folder.id === 'string' &&
        !!folder.id &&
        typeof folder.name === 'string' &&
        finite(folder.createdAt) &&
        finite(folder.order)
    )
  ) {
    throw new SyncError('corrupt')
  }
  return value as unknown as SyncFoldersDocument
}

const portableSettings = (value: unknown): SyncPortableSettings => {
  if (!isRecord(value)) {
    throw new SyncError('corrupt')
  }
  const result: SyncPortableSettings = {}
  for (const key of [
    'thinking',
    'search',
    'autoCollapseThinking',
    'autoCompactContext',
  ] as const) {
    if (value[key] === undefined) {
      continue
    }
    if (typeof value[key] !== 'boolean') {
      throw new SyncError('corrupt')
    }
    result[key] = value[key]
  }
  if (value.chatFontSize !== undefined) {
    if (
      value.chatFontSize !== null &&
      (!Number.isInteger(value.chatFontSize) ||
        Number(value.chatFontSize) < 14 ||
        Number(value.chatFontSize) > 22)
    ) {
      throw new SyncError('corrupt')
    }
    result.chatFontSize = value.chatFontSize as number | null
  }
  return result
}

const parsePromptsDocument = (value: unknown): SyncPromptsDocument => {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !finite(value.updatedAt) ||
    !Array.isArray(value.presets) ||
    value.presets.length > 200 ||
    !value.presets.every(promptItem) ||
    (value.selectedId !== null && typeof value.selectedId !== 'string')
  ) {
    throw new SyncError('corrupt')
  }
  const presets = value.presets.map((preset) => sanitizeSyncValue(preset))
  const selectedId =
    typeof value.selectedId === 'string' &&
    presets.some((preset) => preset.id === value.selectedId)
      ? value.selectedId
      : null
  return {
    version: 1,
    updatedAt: value.updatedAt,
    presets,
    selectedId,
  }
}

const parseSettingsDocument = (value: unknown): SyncSettingsDocument => {
  if (!isRecord(value) || value.version !== 1 || !finite(value.updatedAt)) {
    throw new SyncError('corrupt')
  }
  return {
    version: 1,
    updatedAt: value.updatedAt,
    values: portableSettings(value.values),
  }
}

const readLocalPrompts = (): SyncPromptsDocument => {
  const stored = useSettings.getState().prompts as unknown as {
    presets?: unknown
    selectedId?: unknown
  }
  const presets = Array.isArray(stored?.presets)
    ? stored.presets
        .filter(promptItem)
        .slice(0, 200)
        .map((preset) => sanitizeSyncValue(preset))
    : []
  const selectedId =
    typeof stored?.selectedId === 'string' &&
    presets.some((preset) => preset.id === stored.selectedId)
      ? stored.selectedId
      : null
  return { ...EMPTY_PROMPTS, presets, selectedId }
}

const readLocalSettings = (): SyncPortableSettings => {
  const state = useSettings.getState()
  return {
    thinking: state.thinking,
    search: state.search,
    autoCollapseThinking: state.autoCollapseThinking,
    autoCompactContext: state.autoCompactContext,
    chatFontSize: state.chatFontSize,
  }
}

const promptsHash = (document: SyncPromptsDocument) =>
  hashSyncPayload({ presets: document.presets, selectedId: document.selectedId })

const normalizeFolder = (
  session: Session,
  folderIds: ReadonlySet<string>
): { session: Session; changed: boolean } => {
  if (session.folderId && !folderIds.has(session.folderId)) {
    return { session: { ...session, folderId: null }, changed: true }
  }
  return { session, changed: false }
}

const applyPrompts = (document: SyncPromptsDocument) => {
  const current = readLocalPrompts()
  if (
    JSON.stringify(current.presets) === JSON.stringify(document.presets) &&
    current.selectedId === document.selectedId
  ) {
    return
  }
  const saved = setPrompts({
    presets: document.presets as Parameters<typeof setPrompts>[0]['presets'],
    selectedId: document.selectedId,
  })
  if (!saved) {
    throw new SyncError('localStorage')
  }
}

const applySettings = (document: SyncSettingsDocument) => {
  const values = document.values
  const current = readLocalSettings()
  if (values.thinking !== undefined && values.thinking !== current.thinking) {
    setThinking(values.thinking)
  }
  if (values.search !== undefined && values.search !== current.search) {
    setSearch(values.search)
  }
  if (
    values.autoCollapseThinking !== undefined &&
    values.autoCollapseThinking !== current.autoCollapseThinking
  ) {
    setAutoCollapseThinking(values.autoCollapseThinking)
  }
  if (
    values.autoCompactContext !== undefined &&
    values.autoCompactContext !== current.autoCompactContext
  ) {
    setAutoCompactContext(values.autoCompactContext)
  }
  if (values.chatFontSize !== undefined && values.chatFontSize !== current.chatFontSize) {
    setChatFontSize(values.chatFontSize)
  }
}

const loadLocalSessions = async (
  folderIds: ReadonlySet<string>
): Promise<{
  sessions: Map<string, SyncedSession>
  normalized: Set<string>
}> => {
  const raw = await db.loadAllSessions()
  const sessions = new Map<string, SyncedSession>()
  const normalized = new Set<string>()
  await mapLimit(raw, 4, async (stored) => {
    const clean = sanitizeSession(stored)
    const adjusted = normalizeFolder(clean, folderIds)
    const contentHash = await hashSyncPayload(adjusted.session)
    sessions.set(adjusted.session.id, {
      session: adjusted.session,
      updatedAt: adjusted.session.updatedAt,
      contentHash,
    })
    if (adjusted.changed) {
      normalized.add(adjusted.session.id)
    }
  })
  return { sessions, normalized }
}

const loadRemoteSessions = async (
  provider: RemoteSyncProvider,
  manifest: SyncManifest,
  local: Map<string, SyncedSession>,
  folderIds: ReadonlySet<string>,
  passphrase: string,
  signal: AbortSignal,
  readAll: boolean,
  allowPlaintextMigration: boolean
): Promise<{ sessions: Map<string, SyncedSession>; etags: Map<string, string> }> => {
  const remote = new Map<string, SyncedSession>()
  const etags = new Map<string, string>()
  const needed: string[] = []
  for (const [id, entry] of Object.entries(manifest.sessions)) {
    const localEntry = local.get(id)
    if (!readAll && localEntry && localEntry.contentHash === entry.contentHash) {
      remote.set(id, localEntry)
    } else {
      needed.push(id)
    }
  }
  await mapLimit(needed, 4, async (id) => {
    const raw = await provider.read(sessionPath(id), signal)
    if (!raw) {
      throw new SyncError('corrupt')
    }
    const opened = await openRemoteDocument<unknown>(
      raw.text,
      passphrase,
      allowPlaintextMigration
    )
    if (raw.etag) {
      etags.set(id, raw.etag)
    }
    const read = readRemoteSession(opened.value)
    if (read.id !== id) {
      throw new SyncError('corrupt')
    }
    const adjusted = normalizeFolder(read, folderIds)
    const contentHash = await hashSyncPayload(adjusted.session)
    remote.set(id, {
      session: adjusted.session,
      updatedAt: adjusted.session.updatedAt,
      contentHash,
    })
  })
  return { sessions: remote, etags }
}

const attachmentFiles = (sessions: Iterable<SyncedSession>) => {
  const files = new Map<string, FileAttachment>()
  for (const { session } of sessions) {
    for (const message of session.messages) {
      if (message.role !== 'user') {
        continue
      }
      for (const file of message.files) {
        if (file.isImage && file.size <= MAX_ATTACHMENT_BYTES) {
          files.set(file.id, file)
        }
      }
    }
  }
  return files
}

const downloadAttachments = async ({
  provider,
  passphrase,
  sessions,
  policy,
  allowPlaintextMigration,
  signal,
}: {
  provider: RemoteSyncProvider
  passphrase: string
  sessions: Iterable<SyncedSession>
  policy: AttachmentPolicy
  allowPlaintextMigration: boolean
  signal: AbortSignal
}): Promise<db.StoredFile[]> => {
  if (policy !== 'images') {
    return []
  }
  const candidates = [...attachmentFiles(sessions).values()].sort((a, b) =>
    a.id.localeCompare(b.id)
  )
  const output: db.StoredFile[] = []
  let total = 0
  await mapLimit(candidates, 3, async (file) => {
    if (await db.loadFile(file.id)) {
      return
    }
    let raw: RemoteRead | null
    try {
      raw = await provider.read(blobPath(file.id), signal)
    } catch {
      return
    }
    if (!raw) {
      return
    }
    try {
      const opened = await openRemoteDocument<unknown>(
        raw.text,
        passphrase,
        allowPlaintextMigration
      )
      if (
        !isRecord(opened.value) ||
        opened.value.version !== 1 ||
        typeof opened.value.mimeType !== 'string' ||
        typeof opened.value.data !== 'string'
      ) {
        return
      }
      const bytes = decodeBase64(opened.value.data)
      if (bytes.length > MAX_ATTACHMENT_BYTES || total + bytes.length > MAX_ATTACHMENT_TOTAL) {
        return
      }
      total += bytes.length
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer
      output.push({
        id: file.id,
        blob: new Blob([buffer], { type: opened.value.mimeType }),
      })
    } catch {
      // 单个损坏的附件不阻塞会话同步。
    }
  })
  return output
}

const uploadAttachments = async ({
  provider,
  cipher,
  sessions,
  policy,
  uploaded,
  force,
  signal,
}: {
  provider: RemoteSyncProvider
  cipher: SyncCipher
  sessions: Iterable<SyncedSession>
  policy: AttachmentPolicy
  uploaded: Set<string>
  force: boolean
  signal: AbortSignal
}): Promise<Set<string>> => {
  if (policy !== 'images') {
    return new Set()
  }
  const candidates = [...attachmentFiles(sessions).values()]
    .filter((file) => force || !uploaded.has(file.id))
    .sort((a, b) => a.id.localeCompare(b.id))
  const added = new Set<string>()
  let total = 0
  for (const file of candidates) {
    const blob = await db.loadFile(file.id)
    if (!blob || blob.size > MAX_ATTACHMENT_BYTES || total + blob.size > MAX_ATTACHMENT_TOTAL) {
      continue
    }
    try {
      const data = encodeBase64(new Uint8Array(await blob.arrayBuffer()))
      const text = await cipher.seal({
        version: 1,
        mimeType: file.mimeType || blob.type || 'application/octet-stream',
        data,
      })
      await provider.write(blobPath(file.id), text, {}, signal)
      total += blob.size
      added.add(file.id)
    } catch (error) {
      if (toSyncError(error).code === 'aborted') {
        throw error
      }
      // 附件是尽力同步；失败会在下轮重试，不阻塞会话与设置。
    }
  }
  return added
}

const applyLocalChanges = async ({
  sessions,
  deleted,
  folders,
  deletedFolders,
  files,
  prompts,
  settings,
}: {
  sessions: SyncedSession[]
  deleted: string[]
  folders: Folder[]
  deletedFolders: string[]
  files: db.StoredFile[]
  prompts: SyncPromptsDocument
  settings: SyncSettingsDocument
}) => {
  await db.applySyncChanges({
    sessions: sessions.map((item) => item.session),
    deleteSessionIds: deleted,
    folders,
    deleteFolderIds: deletedFolders,
    files,
  })
  applyPrompts(prompts)
  applySettings(settings)
}

type SyncAttemptResult = SyncResult

const syncAttempt = async ({
  provider,
  config,
  preferences,
  signal,
  now,
}: {
  provider: RemoteSyncProvider
  config: WebDavConfig
  preferences: SyncPreferences
  signal: AbortSignal
  now: number
}): Promise<SyncAttemptResult> => {
  const localState = readSyncState()
  await provider.ensureCollection('', signal)
  await provider.ensureCollection(SESSION_DIR, signal)
  await provider.ensureCollection(BLOB_DIR, signal)

  const manifestRaw = await provider.read(MANIFEST_PATH, signal)
  if (!manifestRaw && localState.baseline) {
    throw new SyncError('notFound')
  }
  let manifest: SyncManifest | null = null
  let cipher: SyncCipher
  let encryptAll = false
  let allowPlaintextMigration = false
  if (manifestRaw) {
    const opened = localState.everEncrypted
      ? await SyncCipher.open<unknown>(manifestRaw.text, config.passphrase, {
          requireEncrypted: true,
        })
      : await SyncCipher.openForInitialMigration<unknown>(
          manifestRaw.text,
          config.passphrase
        )
    manifest = parseManifest(opened.value)
    if (opened.cipher.encrypted) {
      cipher = opened.cipher
    } else {
      cipher = config.passphrase
        ? await SyncCipher.create(config.passphrase)
        : SyncCipher.plain()
    }
    encryptAll = !!config.passphrase && !opened.cipher.encrypted
    allowPlaintextMigration =
      !!config.passphrase &&
      !localState.everEncrypted &&
      !opened.cipher.encrypted
  } else {
    cipher = config.passphrase
      ? await SyncCipher.create(config.passphrase)
      : SyncCipher.plain()
    encryptAll = !!config.passphrase
    allowPlaintextMigration = !!config.passphrase && !localState.everEncrypted
  }

  const foldersRead = await readOptionalDocument(
    provider,
    FOLDERS_PATH,
    config.passphrase,
    parseFoldersDocument,
    allowPlaintextMigration,
    signal
  )
  const promptsRead = await readOptionalDocument(
    provider,
    PROMPTS_PATH,
    config.passphrase,
    parsePromptsDocument,
    allowPlaintextMigration,
    signal
  )
  const settingsRead = await readOptionalDocument(
    provider,
    SETTINGS_PATH,
    config.passphrase,
    parseSettingsDocument,
    allowPlaintextMigration,
    signal
  )
  if (manifest && (!foldersRead || !promptsRead || !settingsRead)) {
    throw new SyncError('corrupt')
  }

  const localFolders = await db.loadFolders()
  const folderMerge = await mergeFolders({
    local: localFolders,
    remote: foldersRead?.value.folders ?? [],
    remoteManifest: manifest,
    baseline: localState.baseline,
    now,
  })
  const folderIds = new Set(folderMerge.folders.map((folder) => folder.id))
  const foldersWrite = encryptAll || !foldersRead || folderMerge.write
  const foldersDocument = folderDocument(
    folderMerge.folders,
    foldersWrite ? now : foldersRead?.value.updatedAt ?? now
  )
  const foldersHash = await hashSyncPayload(folderMerge.folders)

  const local = await loadLocalSessions(folderIds)
  const remoteRead = manifest
    ? await loadRemoteSessions(
        provider,
        manifest,
        local.sessions,
        folderIds,
        config.passphrase,
        signal,
        encryptAll,
        allowPlaintextMigration
      )
    : { sessions: new Map<string, SyncedSession>(), etags: new Map<string, string>() }
  const sessionMerge = await mergeSessions({
    local: local.sessions,
    remote: remoteRead.sessions,
    remoteManifest: manifest,
    baseline: localState.baseline,
    now,
    conflictSuffix: translate('syncConflictCopySuffix'),
  })

  const localPrompts = readLocalPrompts()
  const localPromptsHash = await promptsHash(localPrompts)
  const remotePromptsHash = promptsRead
    ? await promptsHash(promptsRead.value)
    : await hashSyncPayload({ presets: [], selectedId: null })
  const promptMerge = await mergePrompts({
    local: localPrompts,
    remote: promptsRead?.value ?? null,
    baseline: localState.baseline,
    localHash: localPromptsHash,
    remoteHash: remotePromptsHash,
    now,
    conflictSuffix: translate('syncPromptConflictSuffix'),
  })
  const promptsWrite = encryptAll || !promptsRead || promptMerge.write
  const promptsDocument: SyncPromptsDocument = {
    ...promptMerge.document,
    updatedAt: promptsWrite ? now : promptsRead?.value.updatedAt ?? now,
  }
  const promptsContentHash = await promptsHash(promptsDocument)

  const settingsMerge = mergeSettings({
    local: readLocalSettings(),
    remote: settingsRead?.value ?? null,
    baseline: localState.baseline,
    now,
  })
  const settingsWrite = encryptAll || !settingsRead || settingsMerge.write
  const settingsDocument: SyncSettingsDocument = {
    ...settingsMerge.document,
    updatedAt: settingsWrite ? now : settingsRead?.value.updatedAt ?? now,
  }
  const settingsContentHash = await hashSyncPayload(settingsDocument.values)

  const sessionUploads = encryptAll
    ? [...sessionMerge.localSessions.values()]
    : sessionMerge.uploads
  const uniqueUploads = [...new Map(
    sessionUploads.map((item) => [item.session.id, item])
  ).values()]
  const sessionWriteCondition = (id: string) => {
    const etag = remoteRead.etags.get(id)
    // 没有 manifest 记录时允许重写：上次尝试可能已写入切片但未提交 manifest。
    return etag ? { etag } : {}
  }

  const upserts = new Map<string, SyncedSession>()
  for (const item of sessionMerge.imports) {
    upserts.set(item.session.id, item)
  }
  for (const item of sessionMerge.uploads) {
    upserts.set(item.session.id, item)
  }
  for (const id of local.normalized) {
    const item = sessionMerge.localSessions.get(id)
    if (item) {
      upserts.set(id, item)
    }
  }
  for (const id of sessionMerge.deletes) {
    upserts.delete(id)
  }

  const downloadedFiles = await downloadAttachments({
    provider,
    passphrase: config.passphrase,
    sessions: sessionMerge.localSessions.values(),
    policy: preferences.attachmentPolicy,
    allowPlaintextMigration,
    signal,
  })

  const manifestSessions = sessionMerge.remoteSessions
  const nextManifest: SyncManifest = {
    format: SYNC_FORMAT,
    version: SYNC_VERSION,
    updatedAt: now,
    sessions: manifestSessions,
    deletedIds: sessionMerge.tombstones,
    deletedFolderIds: folderMerge.tombstones,
    folders: {
      version: 1,
      updatedAt: foldersDocument.updatedAt,
      contentHash: foldersHash,
    },
    prompts: {
      version: 1,
      updatedAt: promptsDocument.updatedAt,
      contentHash: promptsContentHash,
    },
    settings: {
      version: 1,
      updatedAt: settingsDocument.updatedAt,
      contentHash: settingsContentHash,
    },
  }

  const writeCondition = (read: { etag?: string } | null) => {
    if (!read) {
      return { ifNoneMatch: true }
    }
    return read.etag ? { etag: read.etag } : {}
  }
  if (foldersWrite) {
    await provider.write(
      FOLDERS_PATH,
      await cipher.seal(foldersDocument),
      writeCondition(foldersRead),
      signal
    )
  }
  if (promptsWrite) {
    await provider.write(
      PROMPTS_PATH,
      await cipher.seal(promptsDocument),
      writeCondition(promptsRead),
      signal
    )
  }
  if (settingsWrite) {
    await provider.write(
      SETTINGS_PATH,
      await cipher.seal(settingsDocument),
      writeCondition(settingsRead),
      signal
    )
  }

  await mapLimit(uniqueUploads, 3, async (item) => {
    const text = await cipher.seal(item.session)
    if (text.length > MAX_SESSION_BYTES) {
      throw new SyncError('tooLarge')
    }
    await provider.write(
      sessionPath(item.session.id),
      text,
      sessionWriteCondition(item.session.id),
      signal
    )
  })

  const uploadedFiles = new Set(localState.uploadedFileIds)
  const addedUploads = await uploadAttachments({
    provider,
    cipher,
    sessions: sessionMerge.localSessions.values(),
    policy: preferences.attachmentPolicy,
    uploaded: uploadedFiles,
    force: encryptAll,
    signal,
  })
  for (const id of addedUploads) {
    uploadedFiles.add(id)
  }

  const manifestText = await cipher.seal(nextManifest)
  if (manifestText.length > MAX_SESSION_BYTES) {
    throw new SyncError('tooLarge')
  }
  await provider.write(
    MANIFEST_PATH,
    manifestText,
    writeCondition(manifestRaw),
    signal
  )

  const deletedFolders = localFolders
    .map((folder) => folder.id)
    .filter((id) => !folderIds.has(id))
  await applyLocalChanges({
    sessions: [...upserts.values()],
    deleted: sessionMerge.deletes,
    folders: folderMerge.folders,
    deletedFolders,
    files: downloadedFiles,
    prompts: promptsDocument,
    settings: settingsDocument,
  })

  const sessionHashes = Object.fromEntries(
    [...sessionMerge.localSessions].map(([id, item]) => [id, item.contentHash])
  )
  const savedState = {
    version: 1 as const,
    baseline: {
      manifest: nextManifest,
      sessionHashes,
      folders: folderMerge.folders,
      settings: settingsDocument.values,
      promptsHash: promptsContentHash,
      promptHashes: await promptFingerprints(promptsDocument.presets),
      promptSelectedId: promptsDocument.selectedId,
    },
    lastSyncAt: now,
    deviceId: localState.deviceId,
    everEncrypted: localState.everEncrypted || cipher.encrypted,
    uploadedFileIds: [...uploadedFiles].slice(-5000),
  }
  if (!writeSyncState(savedState)) {
    throw new SyncError('localStorage')
  }
  await refreshChatAfterSync()

  return {
    uploaded: uniqueUploads.length,
    downloaded: sessionMerge.imports.length,
    deleted: sessionMerge.deletes.length,
    conflicts:
      sessionMerge.conflicts + promptMerge.conflicts + folderMerge.conflicts,
    lastSyncAt: now,
  }
}

const performSync = async (
  config: WebDavConfig,
  preferences: SyncPreferences,
  mode: SyncRunMode
): Promise<SyncResult> => {
  const target = validateWebDavConfig(config)
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 180_000)
  const idle = await flushChatForSync()
  if (!idle) {
    clearTimeout(timeout)
    throw new SyncError('busy')
  }
  if (!acquireChatStorageLock()) {
    clearTimeout(timeout)
    throw new SyncError('busy')
  }
  try {
    const provider = new WebDavClient(target)
    for (let attempt = 0; attempt < SYNC_ATTEMPTS; attempt += 1) {
      try {
        return await syncAttempt({
          provider,
          config: target,
          preferences,
          signal: controller.signal,
          now: Date.now(),
        })
      } catch (error) {
        const syncError = toSyncError(error)
        if (timedOut && syncError.code === 'aborted') {
          throw new SyncError('timeout')
        }
        if (syncError.code === 'conflict' && attempt < SYNC_ATTEMPTS - 1) {
          continue
        }
        throw syncError
      }
    }
    throw new SyncError('conflict')
  } finally {
    clearTimeout(timeout)
    releaseChatStorageLock()
    if (mode === 'manual') {
      setSyncPhase('idle')
    }
  }
}

export const testWebDavConnection = async (config: WebDavConfig): Promise<void> => {
  setSyncPhase('testing')
  const controller = new AbortController()
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, 30_000)
  try {
    await new WebDavClient(validateWebDavConfig(config)).test(controller.signal)
    setSyncPhase('idle')
  } catch (error) {
    const syncError = timedOut ? new SyncError('timeout') : toSyncError(error)
    setSyncError(syncError.code)
    throw syncError
  } finally {
    clearTimeout(timeout)
  }
}

export const syncNow = async (
  config?: WebDavConfig,
  preferences?: SyncPreferences
): Promise<SyncResult> => {
  const target = config ?? (await readWebDavConfig())
  if (!target) {
    const error = new SyncError('missingConfig')
    setSyncError(error.code)
    throw error
  }
  setSyncPhase('syncing')
  try {
    const result = await performSync(
      target,
      preferences ?? readSyncPreferences(),
      'manual'
    )
    setSyncSuccess(result.lastSyncAt)
    return result
  } catch (error) {
    const syncError = toSyncError(error)
    setSyncError(syncError.code)
    throw syncError
  }
}

let lastAutoAttempt = 0
let autoTimer: ReturnType<typeof setTimeout> | undefined
let autoRunning = false
let initialScheduled = false

const runAutoSync = async (reason: 'foreground' | 'background') => {
  if (autoRunning || useSyncStatus.getState().phase !== 'idle') {
    return
  }
  const preferences = readSyncPreferences()
  if (!preferences.autoSync) {
    return
  }
  const state = readSyncState()
  const interval =
    reason === 'background' ? AUTO_BACKGROUND_INTERVAL : AUTO_SYNC_INTERVAL
  const last = Math.max(state.lastSyncAt ?? 0, lastAutoAttempt)
  if (Date.now() - last < interval) {
    return
  }
  let config: WebDavConfig | null
  try {
    config = await readWebDavConfig()
  } catch (error) {
    setSyncError(toSyncError(error).code)
    return
  }
  if (!config) {
    return
  }
  autoRunning = true
  lastAutoAttempt = Date.now()
  setSyncPhase('syncing')
  try {
    const result = await performSync(config, preferences, 'auto')
    setSyncSuccess(result.lastSyncAt)
  } catch (error) {
    setSyncError(toSyncError(error).code)
  } finally {
    autoRunning = false
  }
}

/** 前后台事件只安排一次节流同步；不阻塞启动与页面交互。 */
export const requestAutoSync = (reason: 'foreground' | 'background') => {
  if (autoTimer || autoRunning) {
    return
  }
  if (reason === 'foreground' && document.visibilityState === 'hidden') {
    return
  }
  const preferences = readSyncPreferences()
  if (!preferences.autoSync) {
    return
  }
  autoTimer = setTimeout(
    () => {
      autoTimer = undefined
      void runAutoSync(reason)
    },
    reason === 'background' ? 300 : 2500
  )
}

export const scheduleInitialAutoSync = () => {
  if (initialScheduled) {
    return
  }
  initialScheduled = true
  setTimeout(() => requestAutoSync('foreground'), 8000)
}

export const syncPhase = (): SyncPhase => useSyncStatus.getState().phase
