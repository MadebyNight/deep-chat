import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateTokens } from '../chat/compaction.js'
import { buildMemoryPrompt, MEMORY_PROMPT_BUDGET, selectMemories } from './retrieval.js'
import {
  clearMemories,
  forgetMemory,
  listMemories,
  rememberMemory,
  updateMemory,
  type MemoryRepository,
} from './store.js'
import type { MemoryEntry } from './types.js'
import {
  MAX_MEMORY_CONTENT_LENGTH,
  memoryFingerprint,
  MemoryValidationError,
  validateMemoryContent,
} from './validation.js'

const createRepository = (initial: MemoryEntry[] = []) => {
  const entries = new Map(initial.map((entry) => [entry.id, entry]))
  const removed: string[] = []
  const repository: MemoryRepository = {
    async load() {
      return [...entries.values()]
    },
    async save(entry) {
      entries.set(entry.id, entry)
    },
    async remove(id) {
      removed.push(id)
      entries.delete(id)
    },
    async clear() {
      entries.clear()
    },
  }
  return { repository, entries, removed }
}

const entry = (
  partial: Partial<MemoryEntry> & Pick<MemoryEntry, 'id' | 'content'>
): MemoryEntry => ({
  tags: [],
  sourceSessionId: null,
  createdAt: 1,
  updatedAt: 1,
  ...partial,
})

const assertReason = (reason: MemoryValidationError['reason'], run: () => unknown) => {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof MemoryValidationError)
    assert.equal(error.reason, reason)
    return true
  })
}

test('normalizes and deduplicates manual memories without losing the original id', async () => {
  const { repository, entries } = createRepository()
  const first = await rememberMemory('  ＴｙｐｅＳｃｒｉｐｔ 偏好：严格类型。  ', {
    repository,
    now: 10,
    sourceSessionId: 'session-1',
  })
  const duplicate = await rememberMemory('typescript偏好:严格类型', {
    repository,
    now: 20,
    tags: ['coding'],
  })

  assert.equal(first.duplicate, false)
  assert.equal(duplicate.duplicate, true)
  assert.equal(duplicate.entry.id, first.entry.id)
  assert.equal(entries.size, 1)
  assert.deepEqual(duplicate.entry.tags, ['coding'])
  assert.equal(duplicate.entry.sourceSessionId, 'session-1')
  assert.equal(duplicate.entry.updatedAt, 20)
  assert.equal(
    memoryFingerprint('TypeScript，偏好：严格类型。'),
    memoryFingerprint('typescript 偏好 严格类型')
  )
})

test('supports list, edit, forget and clear through the injected repository', async () => {
  const { repository, entries } = createRepository()
  const saved = await rememberMemory('我对花生过敏', { repository, now: 100 })
  const listed = await listMemories({ repository, now: 101 })
  assert.equal(listed.length, 1)

  const updated = await updateMemory(saved.entry.id, '我对花生和腰果过敏', {
    repository,
    now: 102,
  })
  assert.equal(updated.content, '我对花生和腰果过敏')
  assert.equal(updated.createdAt, 100)

  await forgetMemory(saved.entry.id, { repository })
  assert.equal(entries.size, 0)

  await rememberMemory('项目使用 pnpm', { repository })
  await clearMemories({ repository })
  assert.equal(entries.size, 0)
})

test('rejects sensitive credentials and overlong or empty content', () => {
  for (const value of [
    '我的 key 是 sk-1234567890abcdefghijklmnop',
    'Cookie: session=abcdef1234567890',
    'Authorization: Bearer abcdefghijklmnopqrstuvwxyz',
    'password = hunter2hunter2',
    '-----BEGIN RSA PRIVATE KEY-----',
  ]) {
    assertReason('sensitive', () => validateMemoryContent(value))
  }
  assertReason('empty', () => validateMemoryContent('   \n  '))
  assertReason('empty', () => validateMemoryContent('！！！'))
  assertReason('tooLong', () => validateMemoryContent('记'.repeat(MAX_MEMORY_CONTENT_LENGTH + 1)))
})

test('cleans expired entries on read and filters them from retrieval', async () => {
  const now = 1_000
  const expired = entry({
    id: 'expired',
    content: '旧偏好',
    expiresAt: now - 1,
  })
  const active = entry({
    id: 'active',
    content: '当前偏好：简洁回答',
    expiresAt: now + 1_000,
    updatedAt: 2,
  })
  const { repository, entries, removed } = createRepository([expired, active])

  const listed = await listMemories({ repository, now })
  assert.deepEqual(
    listed.map((item) => item.id),
    ['active']
  )
  assert.deepEqual(removed, ['expired'])
  assert.equal(entries.has('expired'), false)
  assert.deepEqual(
    selectMemories([expired, active], '偏好', now).map((item) => item.id),
    ['active']
  )
})

test('ranks relevant tags and content ahead of unrelated memories', () => {
  const entries = [
    entry({
      id: 'food',
      content: '我的猫叫团子，喜欢罐头',
      tags: ['pet'],
      updatedAt: 30,
    }),
    entry({
      id: 'code',
      content: '我偏好 TypeScript 和严格类型检查',
      tags: ['coding'],
      updatedAt: 20,
    }),
  ]
  const selected = selectMemories(entries, '帮我写 TypeScript，记得严格类型', 100)
  assert.equal(selected[0]?.id, 'code')
})

test('strictly caps the injected memory prompt and keeps user priority wording', () => {
  const long = entry({
    id: 'long',
    content: '这是很长的用户偏好。'.repeat(80),
    updatedAt: 2,
  })
  const prompt = buildMemoryPrompt([long], '', { now: 10 })
  assert.ok(prompt)
  assert.ok(estimateTokens(prompt) <= MEMORY_PROMPT_BUDGET)
  assert.match(prompt, /用户当前消息中的指令优先/)
  assert.match(prompt, /…$/)

  const many = Array.from({ length: 30 }, (_, index) =>
    entry({
      id: `item-${index}`,
      content: `偏好 ${index}：${'细节'.repeat(30)}`,
      updatedAt: index,
    })
  )
  const bounded = buildMemoryPrompt(many, '偏好', { now: 100, budget: 180 })
  assert.ok(bounded)
  assert.ok(estimateTokens(bounded) <= 180)
})

test('drops sensitive legacy rows before injection', () => {
  const entries = [
    entry({ id: 'secret', content: 'sk-1234567890abcdefghijklmnop' }),
    entry({ id: 'safe', content: '用户喜欢简短回答' }),
  ]
  assert.deepEqual(
    selectMemories(entries, '回答').map((item) => item.id),
    ['safe']
  )
})

test('update refuses to merge into another existing memory', async () => {
  const { repository } = createRepository([
    entry({ id: 'a', content: '偏好深色主题', updatedAt: 1 }),
    entry({ id: 'b', content: '偏好浅色主题', updatedAt: 2 }),
  ])
  await assert.rejects(
    () => updateMemory('a', '偏好浅色主题', { repository }),
    (error: unknown) => {
      assert.ok(error instanceof MemoryValidationError)
      assert.equal(error.reason, 'duplicate')
      return true
    }
  )
})
