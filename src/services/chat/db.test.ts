import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CORE_STORES, DB_VERSION, missingStores } from './db.js'

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
