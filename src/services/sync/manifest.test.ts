import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SyncError } from './errors.js'
import {
  canonicalJson,
  emptyManifest,
  hashSyncPayload,
  parseManifest,
} from './manifest.js'

const isCode = (code: string) => (error: unknown) =>
  error instanceof SyncError && error.code === code

test('canonical JSON is stable across object key order', async () => {
  const left = { b: 2, a: { d: 4, c: 3 } }
  const right = { a: { c: 3, d: 4 }, b: 2 }
  assert.equal(canonicalJson(left), canonicalJson(right))
  assert.equal(await hashSyncPayload(left), await hashSyncPayload(right))
  assert.notEqual(
    await hashSyncPayload(left),
    await hashSyncPayload({ b: 2, a: { c: 3, d: 5 } })
  )
})

test('empty manifest round-trips and includes tombstones', () => {
  const manifest = emptyManifest(100)
  manifest.deletedIds.old = 90
  manifest.deletedFolderIds.folder = 80
  manifest.sessions.session = {
    id: 'session',
    updatedAt: 95,
    contentHash: 'a'.repeat(64),
  }
  assert.deepEqual(parseManifest(JSON.parse(JSON.stringify(manifest))), manifest)
})

test('newer or malformed manifests are rejected before touching local data', () => {
  const manifest = emptyManifest(100)
  assert.throws(
    () => parseManifest({ ...manifest, version: 2 }),
    isCode('unsupported')
  )
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        sessions: {
          bad: { id: 'bad', updatedAt: 1, contentHash: 'not-a-hash' },
        },
      }),
    isCode('corrupt')
  )
  assert.throws(
    () =>
      parseManifest({
        ...manifest,
        sessions: {
          '../escape': {
            id: '../escape',
            updatedAt: 1,
            contentHash: 'a'.repeat(64),
          },
        },
      }),
    isCode('corrupt')
  )
})
