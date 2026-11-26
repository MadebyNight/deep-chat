import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session } from '../chat/types.js'
import { readRemoteSession, sanitizeSession, sanitizeSyncValue } from './sanitize.js'
import { SyncError } from './errors.js'

test('session payload strips provider, file-service and credential fields', () => {
  const source = {
    id: 's1',
    title: 'Session',
    createdAt: 1,
    updatedAt: 2,
    customProviderId: 'provider-secret',
    systemPromptId: 'prompt-1',
    systemPromptSnapshot: { title: 'Persona', body: 'Keep me' },
    messages: [
      {
        id: 'm1',
        role: 'user',
        content: 'hello',
        createdAt: 1,
        files: [
          {
            id: 'f1',
            serverId: 'file-api-id',
            serverIdScope: 'scope',
            accountFile: { id: 'account-file', scope: 'official' },
            name: 'image.png',
            size: 12,
            isImage: true,
            mimeType: 'image/png',
          },
        ],
      },
    ],
    apiKey: 'sk-secret',
    accessToken: 'token',
  } as unknown as Session

  const clean = sanitizeSession(source)
  const serialized = JSON.stringify(clean)
  assert.doesNotMatch(serialized, /provider-secret|file-api-id|account-file|sk-secret|accessToken/)
  assert.equal(clean.customProviderId, undefined)
  assert.equal((clean as Session & { apiKey?: string }).apiKey, undefined)
  assert.equal(clean.messages[0].role, 'user')
  if (clean.messages[0].role === 'user') {
    assert.equal(clean.messages[0].files[0].serverId, null)
    assert.equal(clean.messages[0].files[0].serverIdScope, undefined)
    assert.equal(clean.messages[0].files[0].accountFile, undefined)
  }
  assert.equal(
    (clean as Session & { systemPromptId?: string }).systemPromptId,
    'prompt-1'
  )
  assert.deepEqual(
    (clean as Session & { systemPromptSnapshot?: unknown }).systemPromptSnapshot,
    { title: 'Persona', body: 'Keep me' }
  )
})

test('prompt-like payload keeps extension fields but drops secrets', () => {
  const clean = sanitizeSyncValue({
    id: 'p1',
    title: 'Role',
    body: 'Body',
    category: 'writing',
    starterPrompt: 'Start',
    createdAt: 1,
    api_key: 'secret',
    nested: { authorization: 'Bearer secret', keep: true },
  })
  assert.deepEqual(clean, {
    id: 'p1',
    title: 'Role',
    body: 'Body',
    category: 'writing',
    starterPrompt: 'Start',
    createdAt: 1,
    nested: { keep: true },
  })
})

test('remote session still validates ids and user attachments', () => {
  assert.throws(
    () =>
      readRemoteSession({
        id: '../escape',
        title: 'bad',
        createdAt: 1,
        updatedAt: 1,
        messages: [],
      }),
    (error: unknown) => error instanceof SyncError && error.code === 'corrupt'
  )
})
