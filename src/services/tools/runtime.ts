import type { CustomToolDefinition } from '../api/client.js'
import { McpError, RemoteMcpClient, type McpCallResult, type McpTool } from '../mcp/remoteClient.js'
import { normalizeMcpUrl, type McpServerConfig, type McpToolInfo } from './config.js'

export type McpToolTarget = {
  alias: string
  server: McpServerConfig
  tool: McpToolInfo
}

export type McpToolCatalog = {
  definitions: CustomToolDefinition[]
  byAlias: Map<string, McpToolTarget>
}

const MAX_TOOL_DEFINITIONS = 32
const MAX_TOOL_SCHEMA_BYTES = 16 * 1024
const MAX_TOOL_DESCRIPTION = 1024
const MAX_ARGUMENT_DEPTH = 8
const UNSAFE_KEYS = new Set(['__proto__', 'prototype', 'constructor'])

export const EXTERNAL_SEARCH_TOOL = 'external_web_search'

export const externalSearchTool: CustomToolDefinition = {
  type: 'function',
  function: {
    name: EXTERNAL_SEARCH_TOOL,
    description: 'Search the public web for current information relevant to the user question.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'A concise web search query.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
}

const hash = (value: string) => {
  let result = 0x811c9dc5
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193)
  }
  return (result >>> 0).toString(36)
}

export const toolAlias = (serverId: string, name: string) => {
  const safe = name.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 32)
  return `mcp_${hash(serverId)}_${hash(name)}_${safe || 'tool'}`
}

export const buildMcpToolCatalog = (servers: McpServerConfig[]): McpToolCatalog => {
  const definitions: CustomToolDefinition[] = []
  const byAlias = new Map<string, McpToolTarget>()
  for (const server of servers) {
    if (!server.enabled || definitions.length >= MAX_TOOL_DEFINITIONS) {
      continue
    }
    for (const tool of server.tools) {
      if (!tool.enabled || definitions.length >= MAX_TOOL_DEFINITIONS) {
        continue
      }
      const alias = toolAlias(server.id, tool.name)
      if (byAlias.has(alias)) {
        continue
      }
      let schema: string
      try {
        schema = JSON.stringify(tool.inputSchema)
      } catch {
        continue
      }
      if (schema.length > MAX_TOOL_SCHEMA_BYTES) {
        continue
      }
      const description = tool.description.slice(0, MAX_TOOL_DESCRIPTION)
      definitions.push({
        type: 'function',
        function: {
          name: alias,
          ...(description ? { description } : {}),
          parameters: tool.inputSchema,
        },
      })
      byAlias.set(alias, { alias, server, tool })
    }
  }
  return { definitions, byAlias }
}

export const toolRequiresConfirmation = (tool: McpToolInfo) => !tool.readOnly

const safeValue = (value: unknown, depth: number): boolean => {
  if (depth > MAX_ARGUMENT_DEPTH) {
    return false
  }
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return true
  }
  if (typeof value === 'number') {
    return Number.isFinite(value)
  }
  if (Array.isArray(value)) {
    return value.every((item) => safeValue(item, depth + 1))
  }
  if (typeof value !== 'object') {
    return false
  }
  for (const [key, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || !safeValue(item, depth + 1)) {
      return false
    }
  }
  return true
}

export const validToolArguments = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || !safeValue(value, 0)) {
    return false
  }
  try {
    return JSON.stringify(value).length <= 64 * 1024
  } catch {
    return false
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const matchesType = (type: unknown, value: unknown): boolean => {
  switch (type) {
    case 'object':
      return isRecord(value)
    case 'array':
      return Array.isArray(value)
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'integer':
      return typeof value === 'number' && Number.isSafeInteger(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'null':
      return value === null
    default:
      return true
  }
}

const matchesSchema = (schema: unknown, value: unknown, depth: number): boolean => {
  if (depth > MAX_ARGUMENT_DEPTH || !isRecord(schema)) {
    return depth <= MAX_ARGUMENT_DEPTH
  }
  if (!matchesType(schema.type, value)) {
    return false
  }
  if (
    Array.isArray(schema.enum) &&
    schema.enum.length > 0 &&
    !schema.enum.some((item) => Object.is(item, value))
  ) {
    return false
  }
  if (typeof value === 'string') {
    if (
      (typeof schema.minLength === 'number' && value.length < schema.minLength) ||
      (typeof schema.maxLength === 'number' && value.length > schema.maxLength)
    ) {
      return false
    }
  }
  if (typeof value === 'number') {
    if (
      (typeof schema.minimum === 'number' && value < schema.minimum) ||
      (typeof schema.maximum === 'number' && value > schema.maximum)
    ) {
      return false
    }
  }
  if (Array.isArray(value)) {
    if (
      (typeof schema.minItems === 'number' && value.length < schema.minItems) ||
      (typeof schema.maxItems === 'number' && value.length > schema.maxItems)
    ) {
      return false
    }
    const items = schema.items
    return items === undefined || value.every((item) => matchesSchema(items, item, depth + 1))
  }
  if (!isRecord(value)) {
    return true
  }
  const properties = isRecord(schema.properties) ? schema.properties : undefined
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string' && !Object.hasOwn(value, name)) {
        return false
      }
    }
  }
  for (const [name, item] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(name)) {
      return false
    }
    if (properties && Object.hasOwn(properties, name)) {
      if (!matchesSchema(properties[name], item, depth + 1)) {
        return false
      }
      continue
    }
    if (schema.additionalProperties === false) {
      return false
    }
    if (
      isRecord(schema.additionalProperties) &&
      !matchesSchema(schema.additionalProperties, item, depth + 1)
    ) {
      return false
    }
  }
  return true
}

export const validateToolArguments = (
  tool: Pick<McpToolInfo, 'inputSchema'>,
  value: unknown
): value is Record<string, unknown> =>
  validToolArguments(value) && matchesSchema(tool.inputSchema, value, 0)

export const executeMcpTool = (
  target: McpToolTarget,
  args: Record<string, unknown>,
  signal: AbortSignal
): Promise<McpCallResult> => {
  if (!validateToolArguments(target.tool, args)) {
    return Promise.reject(new McpError('invalidConfig'))
  }
  const client = new RemoteMcpClient({ url: target.server.url, token: target.server.token })
  return client.callTool(target.tool.name, args, { signal })
}

export const fetchMcpTools = (
  server: Pick<McpServerConfig, 'url' | 'token'>,
  signal: AbortSignal
): Promise<McpTool[]> => {
  const url = normalizeMcpUrl(server.url)
  if (!url) {
    return Promise.reject(new McpError('invalidConfig'))
  }
  return new RemoteMcpClient({ url, token: server.token }).listTools({ signal })
}

export const toStoredTools = (tools: McpTool[], previous: McpToolInfo[]): McpToolInfo[] => {
  const byName = new Map(previous.map((tool) => [tool.name, tool]))
  return tools.map((tool) => {
    const old = byName.get(tool.name)
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      enabled: old?.enabled ?? true,
      readOnly: tool.readOnly,
    }
  })
}

export const formatToolInput = (input: Record<string, unknown>) => {
  try {
    return JSON.stringify(input, null, 2)
  } catch {
    return '{}'
  }
}
