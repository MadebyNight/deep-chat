import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_TOOL_ROUNDS,
  assistantToolMessage,
  collectToolCalls,
  externalSearchFailureBlock,
  externalSearchResultBlock,
  externalSearchUseBlock,
  formatSearchToolResult,
  roundText,
  toCustomToolCall,
  toolErrorMessage,
  toolResultMessage,
} from './toolCalling.js'
import type { ClientToolUseBlock, ReplyBlock } from './types.js'
import { McpError } from '../mcp/remoteClient.js'
import { ExternalSearchError } from '../search/externalSearch.js'

const call: ClientToolUseBlock = {
  type: 'client_tool_use',
  id: 'call-1',
  name: 'mcp_lookup',
  input: { query: 'hello' },
  arguments: '{"query":"hello"}',
  status: 'complete',
}

test('collects only client tool calls after the current round offset', () => {
  const blocks: ReplyBlock[] = [
    { ...call, id: 'old', name: 'old' },
    { type: 'text', text: 'preamble' },
    call,
    { type: 'text', text: 'trailing' },
  ]
  assert.deepEqual(collectToolCalls(blocks, 1), [call])
  assert.equal(roundText(blocks, 1), 'preambletrailing')
  assert.ok(MAX_TOOL_ROUNDS > 0)
})

test('builds standard assistant and tool messages with bounded results', () => {
  assert.deepEqual(toCustomToolCall(call), {
    id: 'call-1',
    type: 'function',
    function: {
      name: 'mcp_lookup',
      arguments: '{"query":"hello"}',
    },
  })
  assert.deepEqual(assistantToolMessage('', [toCustomToolCall(call)]), {
    role: 'assistant',
    content: null,
    tool_calls: [toCustomToolCall(call)],
  })
  const bounded = toolResultMessage('call-1', 'x'.repeat(30_000))
  assert.equal(bounded.role, 'tool')
  assert.equal(bounded.content.length, 24_000)
})

test('maps external search into shared source and result blocks', () => {
  const results = [
    {
      title: 'Result',
      url: 'https://example.com',
      snippet: 'Snippet',
      publishedAt: '2026-11-01',
      siteName: 'example.com',
      siteIcon: null,
    },
  ]
  assert.deepEqual(externalSearchUseBlock('call-1', 'weather'), {
    type: 'server_tool_use',
    id: 'call-1',
    name: 'deepseek_web_search',
    input: { action: 'search', query: 'weather', queries: ['weather'] },
    caller: { type: 'direct' },
    kind: 'search',
  })
  assert.deepEqual(externalSearchResultBlock('call-1', results), {
    type: 'web_search_tool_result',
    tool_use_id: 'call-1',
    content: [
      {
        type: 'web_search_result',
        title: 'Result',
        url: 'https://example.com',
        snippet: 'Snippet',
        site_icon: null,
        site_name: 'example.com',
        encrypted_content: '',
        page_age: '2026-11-01',
      },
    ],
    kind: 'search',
  })
  assert.equal(
    formatSearchToolResult('weather', results),
    '1. Result\nhttps://example.com\nSnippet'
  )
  assert.equal(
    formatSearchToolResult('weather', []),
    'External search returned no results for: weather'
  )
  assert.deepEqual(externalSearchFailureBlock('call-1'), {
    type: 'web_search_tool_result',
    tool_use_id: 'call-1',
    content: [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }],
    kind: 'search',
  })
})

test('returns stable tool error codes without server details or secrets', () => {
  assert.equal(toolErrorMessage(new McpError('timeout')), 'MCP timeout')
  assert.equal(toolErrorMessage(new McpError('http', 503)), 'MCP http (503)')
  assert.equal(
    toolErrorMessage(new ExternalSearchError('rateLimited', 429)),
    'External search rateLimited (429)'
  )
  assert.equal(toolErrorMessage(new DOMException('Cancelled', 'AbortError')), 'cancelled')
  assert.equal(toolErrorMessage(new Error('secret key abc')), 'tool failed')
})
