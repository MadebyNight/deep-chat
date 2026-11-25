import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AssistantMessage, Session, UserMessage } from './types.js'

Object.assign(globalThis, { __API_ORIGIN__: 'https://example.test' })
const { createExportContent, markdownFileName, serializeExportMarkdown } =
  await import('./exportFormats.js')

const labels = {
  question: '提问',
  answer: '回答',
  model: '模型',
  thinking: '思考过程',
  sources: '参考来源',
  attachments: '附件',
}

const user = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
})

const assistant = (
  id: string,
  text: string,
  extra: Partial<AssistantMessage> = {}
): AssistantMessage => ({
  id,
  role: 'assistant',
  createdAt: 2,
  model: 'deepseek-v4-pro',
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text }],
  ...extra,
})

const session = (messages: Session['messages'], title = '分支测试'): Session => ({
  id: 'session',
  title,
  createdAt: 1,
  updatedAt: 2,
  messages,
  rootMessageId: messages[0]?.id ?? null,
  customProviderId: 'must-not-export',
  contextCheckpoint: { version: 1, throughReplyId: 'a1', fingerprint: 'secret', summary: 'hidden' },
})

test('exports only the selected visible branch and omits internal session fields', () => {
  const data = session([
    { ...user('u1', '第一问'), parentId: null, selectedChildId: 'a1' },
    { ...assistant('a1', '选中的第一答'), parentId: 'u1', selectedChildId: 'u2' },
    { ...user('u2', '第二问'), parentId: 'a1', selectedChildId: 'a2' },
    { ...assistant('a2', '第二答'), parentId: 'u2' },
    {
      ...assistant('a1-alt', '未选中的分支', {
        blocks: [
          {
            type: 'text',
            text: '未选中的分支',
            citations: [
              {
                type: 'web_search_result_location',
                url: 'https://hidden.example',
                title: '分支来源',
                cited_text: '',
                encrypted_index: '',
              },
            ],
          },
        ],
      }),
      parentId: 'u1',
    },
  ])
  const content = createExportContent(data, { kind: 'session', sessionId: data.id })
  const markdown = serializeExportMarkdown(content, {
    labels,
    includeThinking: true,
    includeSources: true,
    now: 0,
  })
  assert.match(markdown, /第一问/u)
  assert.match(markdown, /选中的第一答/u)
  assert.match(markdown, /第二答/u)
  assert.doesNotMatch(markdown, /未选中的分支/u)
  assert.doesNotMatch(markdown, /must-not-export|customProviderId|fingerprint|hidden/u)
})

test('single reply can include its question, thinking and linked sources', () => {
  const reply = assistant('a1', '结论见引用。', {
    thinking: true,
    blocks: [
      { type: 'thinking', thinking: '先分析，再作答。' },
      {
        type: 'text',
        text: '结论见引用。[citation:1]',
        citations: [
          {
            type: 'web_search_result_location',
            url: 'https://example.com/a',
            title: 'Example',
            cited_text: 'Example',
            encrypted_index: '',
          },
        ],
      },
    ],
  })
  const data = session([
    { ...user('u1', '这个问题需要解释。'), parentId: null, selectedChildId: 'a1' },
    { ...reply, parentId: 'u1' },
  ])
  const content = createExportContent(
    data,
    { kind: 'message', sessionId: data.id, messageId: 'a1' },
    { includeQuestion: true }
  )
  const markdown = serializeExportMarkdown(content, {
    labels,
    includeThinking: true,
    includeSources: true,
  })
  assert.match(markdown, /这个问题需要解释/u)
  assert.match(markdown, /<details>/u)
  assert.match(markdown, /先分析，再作答/u)
  assert.match(markdown, /\[\[1\]\]\(<https:\/\/example\.com\/a>\)/u)
  assert.match(markdown, /### 参考来源/u)
  assert.match(markdown, /1\. \[Example\]\(<https:\/\/example\.com\/a>\)/u)
  assert.match(markdown, /模型: `deepseek-v4-pro`/u)

  const answerOnly = serializeExportMarkdown(
    createExportContent(
      data,
      { kind: 'message', sessionId: data.id, messageId: 'a1' },
      { includeQuestion: false }
    ),
    { labels, includeThinking: false, includeSources: false }
  )
  assert.doesNotMatch(answerOnly, /这个问题需要解释|先分析/u)
  assert.match(answerOnly, /结论见引用。\[1\]/u)
  assert.doesNotMatch(answerOnly, /参考来源/u)
})

test('exports selected turns in visible order with attachment names only', () => {
  const withFile = user('u1', '看附件')
  withFile.files = [
    {
      id: 'file-id',
      serverId: 'server-file-id',
      name: 'report.pdf',
      size: 42,
      isImage: false,
      mimeType: 'application/pdf',
    },
  ]
  const data = session([
    { ...withFile, parentId: null, selectedChildId: 'a1' },
    { ...assistant('a1', '已阅读。'), parentId: 'u1', selectedChildId: 'u2' },
    { ...user('u2', '第二问'), parentId: 'a1', selectedChildId: 'a2' },
    { ...assistant('a2', '第二答'), parentId: 'u2' },
  ])
  const content = createExportContent(data, {
    kind: 'turns',
    sessionId: data.id,
    userIds: ['u2', 'u1'],
  })
  const markdown = serializeExportMarkdown(content, {
    labels,
    includeThinking: false,
    includeSources: false,
  })
  assert.ok(markdown.indexOf('第一问') < markdown.indexOf('第二问'))
  assert.match(markdown, /附件: `report\.pdf`/u)
  assert.doesNotMatch(markdown, /file-id|server-file-id/u)
})

test('rejects empty or mismatched selections and sanitizes file names', () => {
  const data = session([{ ...user('u1', '问'), parentId: null, selectedChildId: 'a1' }])
  assert.throws(
    () => createExportContent(data, { kind: 'session', sessionId: data.id }),
    /Nothing to export/u
  )
  assert.throws(
    () =>
      createExportContent(data, {
        kind: 'message',
        sessionId: 'other',
        messageId: 'a1',
      }),
    /Nothing to export/u
  )
  const unsafe = session(
    [
      { ...user('u1', '问'), parentId: null, selectedChildId: 'a1' },
      { ...assistant('a1', '答'), parentId: 'u1' },
    ],
    '  ../A:B*?  '
  )
  const content = createExportContent(unsafe, { kind: 'session', sessionId: unsafe.id })
  const name = markdownFileName(content, new Date(2026, 0, 2).getTime())
  assert.match(name, /^A-B-20260102\.md$/u)
  assert.doesNotMatch(name, /[<>:"/\\|?*]/u)
})
