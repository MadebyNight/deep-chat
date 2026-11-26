import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEvent, canContinueReply, settleReply, toRequestMessages } from './reply.js'
import type { AssistantMessage, UserMessage } from './types.js'

const assistant = (): AssistantMessage => ({
  id: 'reply-1',
  role: 'assistant',
  createdAt: 1,
  model: 'test-model',
  prefix: false,
  status: 'streaming',
  blocks: [],
})

const question = (id: string, content: string): UserMessage => ({
  id,
  role: 'user',
  content,
  files: [],
  createdAt: 1,
})

test('streams client tool arguments into a parsed local block', () => {
  const indexes = new Map<number, number>()
  let reply = applyEvent(
    assistant(),
    {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'tool_use',
        id: 'call-1',
        name: 'mcp_lookup',
        input: {},
      },
    },
    1,
    indexes
  )
  reply = applyEvent(
    reply,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '{"query":' },
    },
    2,
    indexes
  )
  reply = applyEvent(
    reply,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: '"hello"}' },
    },
    3,
    indexes
  )
  reply = applyEvent(reply, { type: 'content_block_stop', index: 0 }, 4, indexes)
  assert.deepEqual(reply.blocks, [
    {
      type: 'client_tool_use',
      id: 'call-1',
      name: 'mcp_lookup',
      input: { query: 'hello' },
      arguments: '{"query":"hello"}',
      status: 'streaming',
    },
  ])

  reply = settleReply(reply, 'done', 5)
  assert.equal(reply.blocks[0]?.type, 'client_tool_use')
  assert.equal(reply.blocks[0]?.type === 'client_tool_use' && reply.blocks[0].status, 'complete')
  const withoutToolBlock = {
    ...reply,
    prefix: true,
    stopReason: 'max_tokens' as const,
    blocks: [],
  }
  assert.equal(canContinueReply(withoutToolBlock), true)
  assert.equal(canContinueReply({ ...withoutToolBlock, blocks: reply.blocks }), false)
})

test('never sends local client tool blocks back to the official API', () => {
  const reply: AssistantMessage = {
    ...assistant(),
    status: 'done',
    stopReason: 'end_turn',
    blocks: [
      { type: 'text', text: 'Answer' },
      {
        type: 'client_tool_use',
        id: 'call-secret',
        name: 'mcp_lookup',
        input: { query: 'private' },
        arguments: '{"query":"private"}',
        status: 'complete',
      },
      {
        type: 'client_tool_result',
        tool_use_id: 'call-secret',
        content: 'private result',
        isError: false,
      },
    ],
  }
  const messages = toRequestMessages(
    [question('user-1', 'First question'), reply],
    question('user-2', 'Second question')
  )
  const serialized = JSON.stringify(messages)
  assert.equal(serialized.includes('call-secret'), false)
  assert.equal(serialized.includes('private result'), false)
  assert.equal(serialized.includes('mcp_lookup'), false)
  assert.equal(serialized.includes('Answer'), true)
})
