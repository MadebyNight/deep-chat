import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filterSessions, groupSessions } from './sessionGroups.js'
import type { SessionSummary } from './types.js'

const session = (
  id: string,
  updatedAt: number,
  pinned = false,
  folderId: string | null = null
): SessionSummary => ({
  id,
  title: id,
  createdAt: updatedAt,
  updatedAt,
  pinned,
  folderId,
})

const now = new Date(2026, 10, 25, 12).getTime()
const sessions = [
  session('pinned', now, true, 'work'),
  session('work-today', now, false, 'work'),
  session('personal', now - 86_400_000, false, 'personal'),
  session('unfiled', now - 20 * 86_400_000),
]

test('filterSessions supports all, pinned and folder views', () => {
  assert.deepEqual(
    filterSessions(sessions, { type: 'all' }).map((item) => item.id),
    ['pinned', 'work-today', 'personal', 'unfiled']
  )
  assert.deepEqual(
    filterSessions(sessions, { type: 'pinned' }).map((item) => item.id),
    ['pinned']
  )
  assert.deepEqual(
    filterSessions(sessions, { type: 'folder', folderId: 'work' }).map((item) => item.id),
    ['pinned', 'work-today']
  )
})

test('groupSessions filters a folder before grouping and keeps pinned first', () => {
  const groups = groupSessions(sessions, now, (key) => key, {
    type: 'folder',
    folderId: 'work',
  })
  assert.deepEqual(
    groups.map((group) => [group.key, group.sessions.map((item) => item.id)]),
    [
      ['pinned', ['pinned']],
      ['sessionHistoryTimelineLabelToday', ['work-today']],
    ]
  )
})
