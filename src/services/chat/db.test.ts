import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unreferencedFileIds } from './db.js'

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
