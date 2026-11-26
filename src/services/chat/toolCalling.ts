import type { CustomMessage, CustomToolCall } from '../api/client.js'
import type {
  ServerToolUseBlock,
  WebSearchToolResultBlock,
  WebSearchToolResultError,
} from '../api/types.js'
import type { ClientToolUseBlock, ReplyBlock } from './types.js'
import {
  ExternalSearchError,
  toWebSearchResults,
  type ExternalSearchResult,
} from '../search/externalSearch.js'
import { McpError } from '../mcp/remoteClient.js'

export const MAX_TOOL_ROUNDS = 5
const MAX_TOOL_RESULT_CHARS = 24_000

const resultError: WebSearchToolResultError = {
  type: 'web_search_tool_result_error',
  error_code: 'unavailable',
}

export const collectToolCalls = (blocks: ReplyBlock[], start: number): ClientToolUseBlock[] =>
  blocks
    .slice(start)
    .filter((block): block is ClientToolUseBlock => block.type === 'client_tool_use')

export const roundText = (blocks: ReplyBlock[], start: number) =>
  blocks
    .slice(start)
    .map((block) => (block.type === 'text' ? block.text : ''))
    .join('')
    .trim()

export const toCustomToolCall = (block: ClientToolUseBlock): CustomToolCall => ({
  id: block.id,
  type: 'function',
  function: {
    name: block.name,
    arguments: block.arguments || '{}',
  },
})

export const assistantToolMessage = (content: string, calls: CustomToolCall[]): CustomMessage => ({
  role: 'assistant',
  content: content || null,
  tool_calls: calls,
})

export const toolResultMessage = (toolCallId: string, content: string): CustomMessage => ({
  role: 'tool',
  tool_call_id: toolCallId,
  content: content.slice(0, MAX_TOOL_RESULT_CHARS),
})

export const externalSearchUseBlock = (id: string, query: string): ServerToolUseBlock => ({
  type: 'server_tool_use',
  id,
  name: 'deepseek_web_search',
  input: { action: 'search', query, queries: query ? [query] : [] },
  caller: { type: 'direct' },
  kind: 'search',
})

export const externalSearchResultBlock = (
  toolUseId: string,
  results: ExternalSearchResult[]
): WebSearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: toWebSearchResults(results),
  kind: 'search',
})

export const externalSearchFailureBlock = (toolUseId: string): WebSearchToolResultBlock => ({
  type: 'web_search_tool_result',
  tool_use_id: toolUseId,
  content: [resultError],
  kind: 'search',
})

export const formatSearchToolResult = (query: string, results: ExternalSearchResult[]) => {
  if (results.length === 0) {
    return `External search returned no results for: ${query}`
  }
  const text = results
    .map(
      (item, index) =>
        `${index + 1}. ${item.title}\n${item.url}${item.snippet ? `\n${item.snippet}` : ''}`
    )
    .join('\n\n')
  return text.slice(0, MAX_TOOL_RESULT_CHARS)
}

export const toolErrorMessage = (error: unknown) => {
  if (error instanceof McpError) {
    return `MCP ${error.code}${error.status === undefined ? '' : ` (${error.status})`}`
  }
  if (error instanceof ExternalSearchError) {
    return `External search ${error.code}${error.status === undefined ? '' : ` (${error.status})`}`
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    return 'cancelled'
  }
  return 'tool failed'
}
