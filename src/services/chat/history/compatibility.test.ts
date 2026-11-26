import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Session } from '../types.js'
import { readSessionFile } from './schema.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://example.test' })

const session: Session = {
  id: 'session-1',
  title: 'Folder metadata stays local',
  createdAt: Date.parse('2026-11-25T00:00:00.000Z'),
  updatedAt: Date.parse('2026-11-25T00:00:01.000Z'),
  pinned: false,
  folderId: 'local-folder',
  handoff: {
    version: 1,
    summary: 'local handoff',
    sourceSessionId: 'older',
    sourceTitle: 'Older',
    createdAt: 1,
  },
  rootMessageId: 'u1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: 'Hello',
      files: [],
      createdAt: 1,
      parentId: null,
      selectedChildId: 'a1',
    },
    {
      id: 'a1',
      role: 'assistant',
      createdAt: 2,
      model: 'deepseek-flash',
      prefix: false,
      status: 'done',
      blocks: [{ type: 'text', text: 'Hi' }],
      parentId: 'u1',
    },
  ],
}

test('official history export omits folder and handoff internals', async () => {
  const { toSessionFile } = await import('./toArchive.js')
  const file = toSessionFile(session, () => null)
  assert.equal('folderId' in file, false)
  assert.equal('deepchat_folder_id' in file, false)
  assert.equal('handoff' in file, false)
  const json = JSON.stringify(file)
  assert.doesNotMatch(json, /local-folder|local handoff/u)
})

test('official import ignores unknown local-only fields', async () => {
  const { toSessionFile } = await import('./toArchive.js')
  const file = toSessionFile(session, () => null)
  const raw = {
    ...file,
    deepchat_folder_id: 'local-folder',
    deepchat_handoff: { summary: 'local handoff' },
  }
  const parsed = readSessionFile(raw)
  assert.deepEqual(parsed, file)
})
