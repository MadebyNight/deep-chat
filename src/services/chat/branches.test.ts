import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  appendBranch,
  buildMessageVersions,
  getVisibleMessages,
  getVisibleTurns,
  removeTurns,
} from './branches.js'
import type { AssistantMessage, Session, UserMessage } from './types.js'

const user = (id: string, content: string, fileIds: string[] = []): UserMessage => ({
  id,
  role: 'user',
  content,
  files: fileIds.map((fileId) => ({
    id: fileId,
    serverId: null,
    name: `${fileId}.txt`,
    size: 10,
    isImage: false,
    mimeType: 'text/plain',
  })),
  createdAt: 1,
})

const assistant = (id: string, text: string): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-flash',
  prefix: false,
  status: 'done',
  blocks: [{ type: 'text', text }],
})

const makeSession = (): Session => {
  const base: Session = {
    id: 's1',
    title: 'Test',
    createdAt: 1,
    updatedAt: 1,
    messages: [
      user('u1', 'q1', ['f1']),
      assistant('a1', 'r1'),
      user('u2', 'q2', ['f2']),
      assistant('a2', 'r2'),
    ],
  }
  const withRegen = appendBranch(base, 'u2', [assistant('a2-regen', 'r2-alt')])
  return appendBranch(withRegen, 'a2-regen', [user('u3', 'q3', ['f3']), assistant('a3', 'r3')])
}

test('getVisibleTurns groups visible user-assistant rounds', () => {
  const session = makeSession()
  const turns = getVisibleTurns(getVisibleMessages(session))
  assert.deepEqual(
    turns.map((turn) => [turn.userId, turn.messages.map((m) => m.id)]),
    [
      ['u1', ['u1', 'a1']],
      ['u2', ['u2', 'a2-regen']],
      ['u3', ['u3', 'a3']],
    ]
  )
})

test('removeTurns deletes a middle turn with all regenerated replies and stitches the rest', () => {
  const session = makeSession()
  const updated = removeTurns(session, new Set(['u2']))
  assert.deepEqual(
    getVisibleMessages(updated).map((m) => m.id),
    ['u1', 'a1', 'u3', 'a3']
  )
  assert.equal(updated.messages.some((m) => m.id === 'a2' || m.id === 'a2-regen'), false)
  assert.equal(updated.messages.find((m) => m.id === 'u3')?.parentId, 'a1')
  assert.equal(updated.messages.find((m) => m.id === 'a1')?.selectedChildId, 'u3')
  const versions = buildMessageVersions(updated, new Map())
  assert.equal(versions.get('u3')?.ids.length, 1)
})

test('removeTurns deletes the first turn and promotes the next turn to root', () => {
  const session = makeSession()
  const updated = removeTurns(session, new Set(['u1']))
  assert.equal(updated.rootMessageId, 'u2')
  assert.deepEqual(
    getVisibleMessages(updated).map((m) => m.id),
    ['u2', 'a2-regen', 'u3', 'a3']
  )
  assert.equal(updated.messages.find((m) => m.id === 'u2')?.parentId, null)
})

test('removeTurns deletes multiple non-adjacent turns and handles tail deletion cleanly', () => {
  const base = makeSession()
  const withFour = appendBranch(base, 'a3', [user('u4', 'q4'), assistant('a4', 'r4')])
  const updated = removeTurns(withFour, new Set(['u1', 'u4']))
  assert.deepEqual(
    getVisibleMessages(updated).map((m) => m.id),
    ['u2', 'a2-regen', 'u3', 'a3']
  )
  assert.equal(updated.messages.find((m) => m.id === 'a3')?.selectedChildId, undefined)
})

test('removeTurns clears all messages when every turn is deleted', () => {
  const session = makeSession()
  const updated = removeTurns(session, new Set(['u1', 'u2', 'u3']))
  assert.equal(updated.rootMessageId, null)
  assert.deepEqual(updated.messages, [])
  assert.deepEqual(getVisibleMessages(updated), [])
})

test('removeTurns invalidates contextCheckpoint only when deleted turns affect its prefix', () => {
  const checkpoint = {
    version: 1 as const,
    throughReplyId: 'a2-regen',
    fingerprint: 'fp',
    summary: 'sum',
  }
  const session: Session = { ...makeSession(), contextCheckpoint: checkpoint }

  const afterDeleted = removeTurns(session, new Set(['u3']))
  assert.deepEqual(afterDeleted.contextCheckpoint, checkpoint)

  const prefixDeleted = removeTurns(session, new Set(['u1']))
  assert.equal(prefixDeleted.contextCheckpoint, undefined)

  const boundaryDeleted = removeTurns(session, new Set(['u2']))
  assert.equal(boundaryDeleted.contextCheckpoint, undefined)
})
