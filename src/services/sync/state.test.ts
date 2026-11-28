import assert from 'node:assert/strict'
import { test } from 'node:test'

test('sync state persists encryption history and migrates legacy state', async () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => values.clear(),
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size
    },
  } as Storage
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: storage,
  })

  values.set(
    'deepchat:sync-state-v1',
    JSON.stringify({
      version: 1,
      baseline: null,
      lastSyncAt: null,
      deviceId: 'legacy-device',
      uploadedFileIds: [],
    })
  )
  const { readSyncState, writeSyncState } = await import('./state.js')
  const legacy = readSyncState()
  assert.equal(legacy.everEncrypted, false)

  assert.equal(writeSyncState({ ...legacy, everEncrypted: true }), true)
  assert.equal(readSyncState().everEncrypted, true)
})
