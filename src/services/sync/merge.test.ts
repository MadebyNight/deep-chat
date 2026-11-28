import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Folder, Session } from '../chat/types.js'
import { emptyManifest, hashSyncPayload, parseManifest } from './manifest.js'
import {
  mergeFolders,
  mergePrompts,
  mergeSessions,
  mergeSettings,
  promptFingerprints,
} from './merge.js'
import type {
  SyncBaseline,
  SyncPromptsDocument,
  SyncedSession,
} from './types.js'

const session = (
  id: string,
  updatedAt: number,
  title = `会话 ${id}`
): Session => ({
  id,
  title,
  createdAt: 1,
  updatedAt,
  messages: [],
})

const synced = async (value: Session): Promise<SyncedSession> => ({
  session: value,
  updatedAt: value.updatedAt,
  contentHash: await hashSyncPayload(value),
})

const baselineFor = async (
  sessions: Session[],
  prompts?: SyncPromptsDocument
): Promise<SyncBaseline> => {
  const manifest = emptyManifest(1)
  const hashes: Record<string, string> = {}
  for (const item of sessions) {
    const page = await synced(item)
    manifest.sessions[item.id] = {
      id: item.id,
      updatedAt: item.updatedAt,
      contentHash: page.contentHash,
    }
    hashes[item.id] = page.contentHash
  }
  return {
    manifest,
    sessionHashes: hashes,
    folders: [],
    settings: {},
    promptsHash: prompts
      ? await hashSyncPayload({ presets: prompts.presets, selectedId: prompts.selectedId })
      : await hashSyncPayload({ presets: [], selectedId: null }),
    promptHashes: await promptFingerprints(prompts?.presets ?? []),
    promptSelectedId: prompts?.selectedId ?? null,
  }
}

const remoteManifestFor = async (sessions: Session[]) => {
  const base = await baselineFor(sessions)
  return base.manifest
}

const folderBaseline = (folders: Folder[]): SyncBaseline => ({
  manifest: emptyManifest(1),
  sessionHashes: {},
  folders,
  settings: {},
  promptsHash: 'a'.repeat(64),
  promptHashes: {},
  promptSelectedId: null,
})

const conflictIdFor = (hash: string) => `conflict-${hash.slice(0, 32)}`

test('local-only sessions upload; remote-only sessions import', async () => {
  const localPage = await synced(session('local', 10))
  const remotePage = await synced(session('remote', 10))
  const result = await mergeSessions({
    local: new Map([['local', localPage]]),
    remote: new Map([['remote', remotePage]]),
    remoteManifest: await remoteManifestFor([remotePage.session]),
    baseline: null,
    now: 100,
    conflictSuffix: ' · 冲突',
  })
  assert.deepEqual(result.uploads.map((item) => item.session.id), ['local'])
  assert.deepEqual(result.imports.map((item) => item.session.id), ['remote'])
  assert.equal(result.remoteSessions.local.contentHash, localPage.contentHash)
  assert.equal(result.remoteSessions.remote.contentHash, remotePage.contentHash)
  assert.equal(result.conflicts, 0)
})

test('concurrent edits keep the newer original and a deterministic conflict copy', async () => {
  const base = await baselineFor([session('shared', 10, 'Base')])
  const localPage = await synced(session('shared', 30, 'Local'))
  const remotePage = await synced(session('shared', 20, 'Remote'))
  const options = {
    local: new Map([['shared', localPage]]),
    remote: new Map([['shared', remotePage]]),
    remoteManifest: base.manifest,
    baseline: base,
    now: 100,
    conflictSuffix: ' · 冲突',
  }
  const result = await mergeSessions(options)
  assert.equal(result.conflicts, 1)
  assert.ok(result.uploads.some((item) => item.session.id === 'shared'))
  const conflictId = conflictIdFor(remotePage.contentHash)
  assert.ok(result.imports.some((item) => item.session.id === conflictId))
  assert.ok(result.uploads.some((item) => item.session.id === conflictId))
  assert.ok(result.localSessions.has(conflictId))
  assert.equal(result.localSessions.get('shared')?.session.title, 'Local')

  const again = await mergeSessions(options)
  assert.ok(again.localSessions.has(conflictId))
  assert.equal(again.conflicts, 1)
})

test('remote deletion removes an unchanged local session and writes a tombstone', async () => {
  const original = session('gone', 10)
  const base = await baselineFor([original])
  const result = await mergeSessions({
    local: new Map([['gone', await synced(original)]]),
    remote: new Map(),
    remoteManifest: { ...base.manifest, sessions: {} },
    baseline: base,
    now: 100,
    conflictSuffix: ' · 冲突',
  })
  assert.deepEqual(result.deletes, ['gone'])
  assert.equal(result.tombstones.gone, 100)
  assert.equal(result.remoteSessions.gone, undefined)
})

test('local deletion and remote edit preserve the edit as a conflict copy', async () => {
  const original = session('gone', 10)
  const base = await baselineFor([original])
  const edited = await synced(session('gone', 20, 'Remote edit'))
  const result = await mergeSessions({
    local: new Map(),
    remote: new Map([['gone', edited]]),
    remoteManifest: base.manifest,
    baseline: base,
    now: 100,
    conflictSuffix: ' · 冲突',
  })
  assert.deepEqual(result.deletes, [])
  assert.equal(result.tombstones.gone, 100)
  assert.equal(result.conflicts, 1)
  const conflictId = conflictIdFor(edited.contentHash)
  assert.ok(result.imports.some((item) => item.session.id === conflictId))
  assert.ok(result.uploads.some((item) => item.session.id === conflictId))
  assert.equal(result.remoteSessions.gone, undefined)
  assert.ok(result.remoteSessions[conflictId])
})

test('remote tombstone removes unchanged local data without a conflict copy', async () => {
  const original = session('old', 10)
  const base = await baselineFor([original])
  const result = await mergeSessions({
    local: new Map([['old', await synced(original)]]),
    remote: new Map(),
    remoteManifest: { ...base.manifest, deletedIds: { old: 50 } },
    baseline: base,
    now: 100,
    conflictSuffix: ' · 冲突',
  })
  assert.deepEqual(result.deletes, ['old'])
  assert.equal(result.conflicts, 0)
})

test('prompt edits on both sides keep a conflict copy of the remote prompt', async () => {
  const local: SyncPromptsDocument = {
    version: 1,
    updatedAt: 20,
    presets: [{ id: 'p1', title: 'Local', body: 'local body' }],
    selectedId: 'p1',
  }
  const remote: SyncPromptsDocument = {
    version: 1,
    updatedAt: 10,
    presets: [{
      id: 'p1',
      title: 'Remote',
      body: 'remote body',
      category: 'writing',
      starterPrompt: 'Start',
      createdAt: 7,
    }],
    selectedId: 'p1',
  }
  const baseline = await baselineFor([], {
    version: 1,
    updatedAt: 1,
    presets: [{ id: 'p1', title: 'Base', body: 'base body' }],
    selectedId: 'p1',
  })
  const result = await mergePrompts({
    local,
    remote,
    baseline,
    localHash: await hashSyncPayload({ presets: local.presets, selectedId: local.selectedId }),
    remoteHash: await hashSyncPayload({ presets: remote.presets, selectedId: remote.selectedId }),
    now: 100,
    conflictSuffix: '（冲突）',
  })
  assert.equal(result.conflicts, 1)
  assert.equal(result.document.presets.length, 2)
  assert.equal(result.document.presets[0].title, 'Local')
  assert.equal(result.document.presets[1].title, 'Remote（冲突）')
  assert.equal(result.document.presets[1].category, 'writing')
  assert.equal(result.document.presets[1].starterPrompt, 'Start')
  assert.equal(result.document.presets[1].createdAt, 7)
})

test('local prompt deletion removes an unchanged remote prompt', async () => {
  const original: SyncPromptsDocument = {
    version: 1,
    updatedAt: 1,
    presets: [{ id: 'p1', title: 'Base', body: 'base body' }],
    selectedId: 'p1',
  }
  const remote: SyncPromptsDocument = {
    ...original,
    updatedAt: 10,
  }
  const local: SyncPromptsDocument = {
    version: 1,
    updatedAt: 20,
    presets: [],
    selectedId: null,
  }
  const result = await mergePrompts({
    local,
    remote,
    baseline: await baselineFor([], original),
    localHash: await hashSyncPayload({
      presets: local.presets,
      selectedId: local.selectedId,
    }),
    remoteHash: await hashSyncPayload({
      presets: remote.presets,
      selectedId: remote.selectedId,
    }),
    now: 100,
    conflictSuffix: '（冲突）',
  })
  assert.deepEqual(result.document.presets, [])
  assert.equal(result.document.selectedId, null)
  assert.equal(result.conflicts, 0)
  assert.equal(result.write, true)
})

test('local prompt deletion preserves a remote edit as a conflict copy', async () => {
  const original: SyncPromptsDocument = {
    version: 1,
    updatedAt: 1,
    presets: [{ id: 'p1', title: 'Base', body: 'base body' }],
    selectedId: 'p1',
  }
  const remote: SyncPromptsDocument = {
    version: 1,
    updatedAt: 10,
    presets: [{ id: 'p1', title: 'Remote edit', body: 'remote body' }],
    selectedId: 'p1',
  }
  const local: SyncPromptsDocument = {
    version: 1,
    updatedAt: 20,
    presets: [],
    selectedId: null,
  }
  const remoteHash = await hashSyncPayload({
    presets: remote.presets,
    selectedId: remote.selectedId,
  })
  const result = await mergePrompts({
    local,
    remote,
    baseline: await baselineFor([], original),
    localHash: await hashSyncPayload({
      presets: local.presets,
      selectedId: local.selectedId,
    }),
    remoteHash,
    now: 100,
    conflictSuffix: '（冲突）',
  })
  assert.equal(result.conflicts, 1)
  assert.equal(result.document.presets.length, 1)
  const itemHash = await hashSyncPayload(remote.presets[0])
  assert.equal(
    result.document.presets[0].id,
    conflictIdFor(itemHash)
  )
  assert.equal(result.document.presets[0].title, 'Remote edit（冲突）')
  assert.equal(result.document.selectedId, null)
})

test('remote prompt deletion preserves a local edit as a conflict copy', async () => {
  const original: SyncPromptsDocument = {
    version: 1,
    updatedAt: 1,
    presets: [{ id: 'p1', title: 'Base', body: 'base body' }],
    selectedId: 'p1',
  }
  const local: SyncPromptsDocument = {
    version: 1,
    updatedAt: 20,
    presets: [{ id: 'p1', title: 'Local edit', body: 'local body' }],
    selectedId: 'p1',
  }
  const remote: SyncPromptsDocument = {
    version: 1,
    updatedAt: 10,
    presets: [],
    selectedId: null,
  }
  const itemHash = await hashSyncPayload(local.presets[0])
  const result = await mergePrompts({
    local,
    remote,
    baseline: await baselineFor([], original),
    localHash: await hashSyncPayload({
      presets: local.presets,
      selectedId: local.selectedId,
    }),
    remoteHash: await hashSyncPayload({
      presets: remote.presets,
      selectedId: remote.selectedId,
    }),
    now: 100,
    conflictSuffix: '（冲突）',
  })
  assert.equal(result.conflicts, 1)
  assert.equal(result.document.presets.length, 1)
  assert.equal(
    result.document.presets[0].id,
    conflictIdFor(itemHash)
  )
  assert.equal(result.document.presets[0].title, 'Local edit（冲突）')
  assert.equal(result.document.selectedId, null)
})

test('folder deletion uses a tombstone; settings merge keeps local changed fields', async () => {
  const folder: Folder = { id: 'f1', name: 'Base', createdAt: 1, order: 1 }
  const baseline = {
    ...emptyManifest(1),
    folders: { version: 1, updatedAt: 1, contentHash: 'a'.repeat(64) },
  }
  const folderResult = await mergeFolders({
    local: [],
    remote: [folder],
    remoteManifest: baseline,
    baseline: {
      manifest: baseline,
      sessionHashes: {},
      folders: [folder],
      settings: {},
      promptsHash: 'b'.repeat(64),
      promptHashes: {},
      promptSelectedId: null,
    },
    now: 100,
  })
  assert.deepEqual(folderResult.folders, [])
  assert.equal(folderResult.tombstones.f1, 100)

  const settings = mergeSettings({
    local: { thinking: true, search: false },
    remote: {
      version: 1,
      updatedAt: 10,
      values: { thinking: false, search: true },
    },
    baseline: {
      manifest: emptyManifest(1),
      sessionHashes: {},
      folders: [],
      settings: { thinking: false, search: false },
      promptsHash: 'b'.repeat(64),
      promptHashes: {},
      promptSelectedId: null,
    },
    now: 100,
  })
  assert.equal(settings.document.values.thinking, true)
  assert.equal(settings.document.values.search, true)
})

test('concurrent folder renames keep both names with a deterministic copy', async () => {
  const id = 'f'.repeat(256)
  const baseFolder: Folder = { id, name: 'Base', createdAt: 1, order: 1 }
  const localFolder: Folder = { ...baseFolder, name: 'Local rename' }
  const remoteFolder: Folder = { ...baseFolder, name: 'Remote rename' }
  const baseline = folderBaseline([baseFolder])
  const localMerge = await mergeFolders({
    local: [localFolder],
    remote: [remoteFolder],
    remoteManifest: baseline.manifest,
    baseline,
    now: 100,
  })
  const remoteMerge = await mergeFolders({
    local: [remoteFolder],
    remote: [localFolder],
    remoteManifest: baseline.manifest,
    baseline,
    now: 100,
  })

  assert.deepEqual(localMerge.folders, remoteMerge.folders)
  assert.equal(localMerge.conflicts, 1)
  assert.equal(localMerge.folders.length, 2)
  assert.deepEqual(
    new Set(localMerge.folders.map((folder) => folder.name)),
    new Set(['Local rename', 'Remote rename'])
  )
  const copy = localMerge.folders.find((folder) => folder.id !== id)
  assert.ok(copy)
  assert.match(copy.id, /^conflict-[0-9a-f]{32}$/)
  assert.ok(copy.id.length <= 256)
  assert.equal(localMerge.tombstones[id], undefined)
  assert.deepEqual(localMerge.deletedFolderIds, [])
})

test('remote folder deletion preserves a concurrent local rename as a copy', async () => {
  const id = 'renamed-folder'
  const baseFolder: Folder = { id, name: 'Base', createdAt: 1, order: 1 }
  const baseline = folderBaseline([baseFolder])
  const renamed: Folder = { ...baseFolder, name: 'Local rename' }
  const result = await mergeFolders({
    local: [renamed],
    remote: [],
    remoteManifest: {
      ...baseline.manifest,
      deletedFolderIds: { [id]: 50 },
    },
    baseline,
    now: 100,
  })

  assert.equal(result.conflicts, 1)
  assert.ok(result.folders.some((folder) => folder.name === 'Local rename'))
  assert.equal(result.folders.some((folder) => folder.id === id), false)
  assert.ok(result.deletedFolderIds.includes(id))
  assert.equal(result.tombstones[id], 50)
})

test('conflict ids for maximum-length session ids pass manifest validation', async () => {
  const id = 's'.repeat(256)
  const base = await baselineFor([session(id, 10, 'Base')])
  const localPage = await synced(session(id, 30, 'Local'))
  const remotePage = await synced(session(id, 20, 'Remote'))
  const result = await mergeSessions({
    local: new Map([[id, localPage]]),
    remote: new Map([[id, remotePage]]),
    remoteManifest: base.manifest,
    baseline: base,
    now: 100,
    conflictSuffix: ' · 冲突',
  })
  const conflict = result.imports.find((item) => item.session.id.startsWith('conflict-'))

  assert.ok(conflict)
  assert.match(conflict.session.id, /^conflict-[0-9a-f]{32}$/)
  assert.ok(conflict.session.id.length <= 256)
  const manifest = {
    ...base.manifest,
    sessions: result.remoteSessions,
    deletedIds: result.tombstones,
  }
  assert.doesNotThrow(() => parseManifest(JSON.parse(JSON.stringify(manifest))))
})

test('prompt conflict ids for maximum-length ids stay short', async () => {
  const id = 'p'.repeat(256)
  const original: SyncPromptsDocument = {
    version: 1,
    updatedAt: 1,
    presets: [{ id, title: 'Base', body: 'base body' }],
    selectedId: id,
  }
  const local: SyncPromptsDocument = {
    ...original,
    updatedAt: 20,
    presets: [{ id, title: 'Local', body: 'local body' }],
  }
  const remote: SyncPromptsDocument = {
    ...original,
    updatedAt: 10,
    presets: [{ id, title: 'Remote', body: 'remote body' }],
  }
  const result = await mergePrompts({
    local,
    remote,
    baseline: await baselineFor([], original),
    localHash: await hashSyncPayload({
      presets: local.presets,
      selectedId: local.selectedId,
    }),
    remoteHash: await hashSyncPayload({
      presets: remote.presets,
      selectedId: remote.selectedId,
    }),
    now: 100,
    conflictSuffix: '（冲突）',
  })
  const copy = result.document.presets.find((item) => item.id !== id)

  assert.ok(copy)
  assert.match(String(copy.id), /^conflict-[0-9a-f]{32}$/)
  assert.ok(String(copy.id).length <= 256)
})
