import { create } from 'zustand'
import { credentials, isNative } from '../native.js'
import { readPreference, writePreference } from '../settings.js'
import { SyncError } from './errors.js'
import { parseManifest } from './manifest.js'
import { validateWebDavConfig } from './webdav.js'
import type {
  AttachmentPolicy,
  SyncBaseline,
  SyncLocalState,
  SyncPreferences,
  SyncPortableSettings,
  WebDavConfig,
} from './types.js'

const CREDENTIAL_SLOT = 'webdav' as const
const STATE_KEY = 'deepchat:sync-state-v1'
const PREFERENCES_KEY = 'deepchat:sync-preferences-v1'

const emptyState = (): SyncLocalState => ({
  version: 1,
  baseline: null,
  lastSyncAt: null,
  deviceId: crypto.randomUUID(),
  everEncrypted: false,
  uploadedFileIds: [],
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

const text = (value: unknown): value is string => typeof value === 'string'

const parseFolders = (value: unknown) => {
  if (!Array.isArray(value)) {
    return null
  }
  const folders = value.filter(
    (item) =>
      isRecord(item) &&
      text(item.id) &&
      text(item.name) &&
      finite(item.createdAt) &&
      finite(item.order)
  ) as unknown as SyncBaseline['folders']
  return folders.length === value.length ? folders : null
}

const parseSettings = (value: unknown): SyncPortableSettings | null => {
  if (value === undefined) {
    return {}
  }
  if (!isRecord(value)) {
    return null
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
      return null
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
      return null
    }
    result.chatFontSize = value.chatFontSize as number | null
  }
  return result
}

const promptHashes = (value: unknown): Record<string, string> | null => {
  if (value === undefined) {
    return {}
  }
  if (
    !isRecord(value) ||
    !Object.values(value).every(
      (hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
    )
  ) {
    return null
  }
  return value as Record<string, string>
}

const parseBaseline = (value: unknown): SyncBaseline | null => {
  if (!isRecord(value)) {
    return null
  }
  try {
    const manifest = parseManifest(value.manifest)
    const folders = parseFolders(value.folders)
    const settings = parseSettings(value.settings)
    const hashes = promptHashes(value.promptHashes)
    if (
      !folders ||
      !settings ||
      !hashes ||
      !isRecord(value.sessionHashes) ||
      !Object.values(value.sessionHashes).every(
        (hash) => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash)
      ) ||
      typeof value.promptsHash !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.promptsHash) ||
      (value.promptSelectedId !== undefined &&
        value.promptSelectedId !== null &&
        typeof value.promptSelectedId !== 'string')
    ) {
      return null
    }
    return {
      manifest,
      sessionHashes: value.sessionHashes as Record<string, string>,
      folders,
      settings,
      promptsHash: value.promptsHash,
      promptHashes: hashes,
      promptSelectedId:
        typeof value.promptSelectedId === 'string' ? value.promptSelectedId : null,
    }
  } catch {
    return null
  }
}

export const readSyncState = (): SyncLocalState => {
  const raw = readPreference(STATE_KEY)
  if (!raw) {
    return emptyState()
  }
  try {
    const stored = JSON.parse(raw) as unknown
    if (!isRecord(stored) || stored.version !== 1) {
      return emptyState()
    }
    return {
      version: 1,
      baseline: parseBaseline(stored.baseline),
      lastSyncAt: finite(stored.lastSyncAt) ? stored.lastSyncAt : null,
      deviceId: text(stored.deviceId) && stored.deviceId
        ? stored.deviceId
        : crypto.randomUUID(),
      everEncrypted: stored.everEncrypted === true,
      uploadedFileIds: Array.isArray(stored.uploadedFileIds)
        ? [...new Set(stored.uploadedFileIds.filter(
            (id): id is string => typeof id === 'string' && !!id && id.length <= 256
          ))].slice(-5000)
        : [],
    }
  } catch {
    return emptyState()
  }
}

export const writeSyncState = (state: SyncLocalState): boolean =>
  writePreference(STATE_KEY, JSON.stringify(state))

const defaultPreferences = (): SyncPreferences => ({
  autoSync: false,
  attachmentPolicy: 'metadata',
})

export const readSyncPreferences = (): SyncPreferences => {
  const raw = readPreference(PREFERENCES_KEY)
  if (!raw) {
    return defaultPreferences()
  }
  try {
    const stored = JSON.parse(raw) as unknown
    if (!isRecord(stored)) {
      return defaultPreferences()
    }
    return {
      autoSync: stored.autoSync === true,
      attachmentPolicy:
        stored.attachmentPolicy === 'images' ? 'images' : 'metadata',
    }
  } catch {
    return defaultPreferences()
  }
}

export const writeSyncPreferences = (preferences: SyncPreferences): boolean => {
  const value: SyncPreferences = {
    autoSync: preferences.autoSync === true,
    attachmentPolicy:
      preferences.attachmentPolicy === 'images' ? 'images' : 'metadata',
  }
  return writePreference(PREFERENCES_KEY, JSON.stringify(value))
}

export const readWebDavConfig = async (): Promise<WebDavConfig | null> => {
  if (!isNative) {
    throw new SyncError('nativeOnly')
  }
  let value: string | null
  try {
    ({ value } = await credentials.read({ slot: CREDENTIAL_SLOT }))
  } catch (error) {
    throw new SyncError('decrypt')
  }
  if (!value) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new SyncError('corrupt')
  }
  if (
    !isRecord(parsed) ||
    !text(parsed.url) ||
    !text(parsed.username) ||
    !text(parsed.password) ||
    !text(parsed.passphrase)
  ) {
    throw new SyncError('corrupt')
  }
  return {
    url: parsed.url,
    username: parsed.username,
    password: parsed.password,
    passphrase: parsed.passphrase,
  }
}

export const writeWebDavConfig = async (config: WebDavConfig | null): Promise<void> => {
  if (!isNative) {
    throw new SyncError('nativeOnly')
  }
  const normalized = config === null ? null : validateWebDavConfig(config)
  try {
    await credentials.write({
      slot: CREDENTIAL_SLOT,
      value: normalized === null ? null : JSON.stringify(normalized),
    })
  } catch {
    throw new SyncError('localStorage')
  }
}

export type SyncPhase = 'idle' | 'testing' | 'syncing'
export type SyncOutcome = 'success' | 'error' | null

const initialSyncState = readSyncState()

export const useSyncStatus = create<{
  phase: SyncPhase
  outcome: SyncOutcome
  error: string | null
  lastSyncAt: number | null
}>(() => ({
  phase: 'idle',
  outcome: initialSyncState.lastSyncAt ? 'success' : null,
  error: null,
  lastSyncAt: initialSyncState.lastSyncAt,
}))

export const setSyncPhase = (phase: SyncPhase) => {
  useSyncStatus.setState({ phase, error: null })
}

export const setSyncError = (code: string) => {
  useSyncStatus.setState({ phase: 'idle', outcome: 'error', error: code })
}

export const setSyncSuccess = (lastSyncAt: number) => {
  useSyncStatus.setState({
    phase: 'idle',
    outcome: 'success',
    error: null,
    lastSyncAt,
  })
}

export const attachmentPolicyLabel = (policy: AttachmentPolicy) =>
  policy === 'images' ? 'images' : 'metadata'
