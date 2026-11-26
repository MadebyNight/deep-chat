import assert from 'node:assert/strict'
import { test } from 'node:test'
import { httpError, SyncError, toSyncError } from './errors.js'

test('HTTP status codes map to stable sync errors', () => {
  assert.equal(httpError(401).code, 'auth')
  assert.equal(httpError(403).code, 'forbidden')
  assert.equal(httpError(404).code, 'notFound')
  assert.equal(httpError(408).code, 'timeout')
  assert.equal(httpError(409).code, 'conflict')
  assert.equal(httpError(412).code, 'conflict')
  assert.equal(httpError(413).code, 'tooLarge')
  assert.equal(httpError(423).code, 'locked')
  assert.equal(httpError(429).code, 'rateLimited')
  assert.equal(httpError(507).code, 'quota')
  assert.equal(httpError(503).code, 'server')
  assert.equal(httpError(400).code, 'unknown')
})

test('native plugin codes and abort errors are classified', () => {
  assert.equal(toSyncError({ code: 'AUTH_REQUIRED' }).code, 'auth')
  assert.equal(toSyncError({ code: 'INVALID_URL' }).code, 'invalidUrl')
  assert.equal(toSyncError({ code: 'TIMEOUT' }).code, 'timeout')
  assert.equal(toSyncError({ code: 'REDIRECT_BLOCKED' }).code, 'redirect')
  assert.equal(toSyncError({ code: 'RESPONSE_TOO_LARGE' }).code, 'tooLarge')
  assert.equal(toSyncError({ name: 'AbortError' }).code, 'aborted')
  assert.equal(toSyncError(new SyncError('decrypt')).code, 'decrypt')
})

test('unknown failures stay opaque and do not leak messages', () => {
  const error = toSyncError(new Error('secret token abc'))
  assert.equal(error.code, 'unknown')
  assert.equal(error.message, 'unknown')
})
