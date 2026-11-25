import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CreateMessageRequest } from '../api/types.js'
import { createHandoffSession, customSummaryMessages } from './handoff.js'
import type { Session } from './types.js'

const source: Session = {
  id: 'source',
  title: '原对话',
  createdAt: 1,
  updatedAt: 2,
  folderId: 'work',
  customProviderId: 'provider-1',
  messages: [
    {
      id: 'u1',
      role: 'user',
      content: '问题',
      files: [],
      createdAt: 1,
    },
  ],
  rootMessageId: 'u1',
}

test('createHandoffSession preserves folder/provider intent without copying messages', () => {
  const before = structuredClone(source)
  const session = createHandoffSession(source, '  当前进展摘要  ', 'new', '摘要续聊', 3)
  assert.equal(session.folderId, 'work')
  assert.equal(session.customProviderId, 'provider-1')
  assert.deepEqual(session.messages, [])
  assert.equal(session.handoff?.summary, '当前进展摘要')
  assert.equal(session.handoff?.sourceSessionId, 'source')
  assert.deepEqual(source, before)
})

test('customSummaryMessages sends the fixed system instruction and transcript as text', () => {
  const body: CreateMessageRequest = {
    model: 'deepseek-flash',
    system: 'Summarize safely',
    messages: [
      {
        role: 'user',
        content: 'Previous summary:\nold\n\nTranscript:\nnew',
      },
    ],
    thinking: { type: 'disabled' },
    tools: [],
    safety_check: { level: 'high' },
    max_tokens: 2000,
  }
  assert.deepEqual(customSummaryMessages(body), [
    { role: 'system', content: 'Summarize safely' },
    { role: 'user', content: 'Previous summary:\nold\n\nTranscript:\nnew' },
  ])
})
