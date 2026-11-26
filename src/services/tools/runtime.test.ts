import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  EXTERNAL_SEARCH_TOOL,
  buildMcpToolCatalog,
  externalSearchTool,
  formatToolInput,
  toStoredTools,
  toolAlias,
  toolRequiresConfirmation,
  validateToolArguments,
} from './runtime.js'
import type { McpServerConfig, McpToolInfo } from './config.js'

const tool = (
  name: string,
  readOnly = true,
  inputSchema: Record<string, unknown> = {
    type: 'object',
    properties: { query: { type: 'string', minLength: 1 } },
    required: ['query'],
    additionalProperties: false,
  }
): McpToolInfo => ({
  name,
  description: `${name} description`,
  inputSchema,
  enabled: true,
  readOnly,
})

const server = (id: string, tools: McpToolInfo[]): McpServerConfig => ({
  id,
  name: id,
  url: `https://${id}.example.com/mcp`,
  token: '',
  enabled: true,
  tools,
})

test('builds bounded, stable aliases without exposing server identifiers', () => {
  const catalog = buildMcpToolCatalog([
    server('server-one', [tool('read_page'), { ...tool('disabled'), enabled: false }]),
  ])
  assert.equal(catalog.definitions.length, 1)
  assert.equal(catalog.byAlias.size, 1)
  const alias = catalog.definitions[0].function.name
  assert.equal(alias, toolAlias('server-one', 'read_page'))
  assert.equal(alias.includes('server-one'), false)
  assert.equal(catalog.byAlias.get(alias)?.tool.name, 'read_page')

  const colliding = buildMcpToolCatalog([
    server('collision', [tool('read.page'), tool('read_page')]),
  ])
  assert.equal(colliding.definitions.length, 2)
  assert.equal(new Set(colliding.definitions.map(({ function: fn }) => fn.name)).size, 2)

  const many = Array.from({ length: 40 }, (_, index) => tool(`tool_${index}`))
  assert.equal(buildMcpToolCatalog([server('limit', many)]).definitions.length, 32)
  assert.equal(externalSearchTool.function.name, EXTERNAL_SEARCH_TOOL)
})

test('requires confirmation unless the server explicitly marks a non-destructive read-only tool', () => {
  assert.equal(toolRequiresConfirmation(tool('read', true)), false)
  assert.equal(toolRequiresConfirmation(tool('write', false)), true)
})

test('validates tool arguments against types, required fields and prototype keys', () => {
  const schema = tool('lookup')
  assert.equal(validateToolArguments(schema, { query: 'hello' }), true)
  assert.equal(validateToolArguments(schema, {}), false)
  assert.equal(validateToolArguments(schema, { query: '' }), false)
  assert.equal(validateToolArguments(schema, { query: 'x', extra: true }), false)
  assert.equal(
    validateToolArguments(schema, JSON.parse('{"query":"x","__proto__":{"polluted":true}}')),
    false
  )

  const nested = tool('nested', true, {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        maxItems: 2,
        items: { type: 'string', maxLength: 3 },
      },
    },
    required: ['items'],
    additionalProperties: false,
  })
  assert.equal(validateToolArguments(nested, { items: ['a', 'bb'] }), true)
  assert.equal(validateToolArguments(nested, { items: ['a', 'bb', 'c'] }), false)
  assert.equal(validateToolArguments(nested, { items: ['long'] }), false)
  assert.equal(validateToolArguments(tool('large'), { query: 'x'.repeat(64 * 1024 + 1) }), false)
})

test('preserves tool enablement when refreshing a server catalog', () => {
  const previous = [
    { ...tool('read_page'), enabled: false },
    { ...tool('old'), enabled: true },
  ]
  assert.deepEqual(
    toStoredTools(
      [
        { ...tool('read_page'), readOnly: false },
        { ...tool('new'), readOnly: false },
      ],
      previous
    ).map(({ name, enabled, readOnly }) => ({ name, enabled, readOnly })),
    [
      { name: 'read_page', enabled: false, readOnly: false },
      { name: 'new', enabled: true, readOnly: false },
    ]
  )
  assert.equal(formatToolInput({ query: 'hello' }), '{\n  "query": "hello"\n}')
})
