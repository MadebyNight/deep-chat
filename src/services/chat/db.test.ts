import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORE_STORES, DB_VERSION, missingStores, unreferencedFileIds } from './db.js'

test('deleting the fork keeps an attachment still referenced by the original session', () => {
  const fork = { fileIds: ['shared', 'fork-only'] }
  const original = { fileIds: ['shared'] }
  assert.deepEqual(unreferencedFileIds(fork.fileIds, [original]), ['fork-only'])
})

test('deleting the original keeps an attachment still referenced by the fork', () => {
  const fork = { fileIds: ['shared', 'fork-only'] }
  const original = { fileIds: ['shared'] }
  assert.deepEqual(unreferencedFileIds(original.fileIds, [fork]), [])
})

test('the last session referencing an attachment releases its local binary', () => {
  assert.deepEqual(unreferencedFileIds(['shared', 'shared'], [{ fileIds: ['different'] }]), [
    'shared',
  ])
})

test('uses a version above the folders migration and keeps the memories store', () => {
  assert.equal(DB_VERSION, 13)
  assert.ok(DB_VERSION > 12)
  assert.ok(CORE_STORES.includes('memories'))
})

test('creates only missing stores so v11/v12 data survives incremental upgrades', () => {
  const existing = new Set([
    'sessions',
    'sessionSummaries',
    'files',
    'sessionsStaging',
    'filesStaging',
  ])
  const missing = missingStores({ contains: (name) => existing.has(name) }, CORE_STORES)
  assert.deepEqual(missing, ['memories'])

  existing.add('memories')
  assert.deepEqual(missingStores({ contains: (name) => existing.has(name) }, CORE_STORES), [])
})
