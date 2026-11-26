import { create } from 'zustand'
import { credentials, isNative } from '../native.js'
import { hasControlCharacter, isBlockedExternalHostname } from './http.js'

export type ExternalSearchProvider = 'searxng' | 'tavily' | 'exa' | 'brave'

export type ExternalSearchConfig = {
  enabled: boolean
  provider: ExternalSearchProvider
  baseUrl: string
  apiKey: string
}

export type McpToolInfo = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  enabled: boolean
  /** 只有显式标记 readOnlyHint 且未标记 destructiveHint 的工具才自动执行。 */
  readOnly: boolean
}

export type McpServerConfig = {
  id: string
  name: string
  url: string
  token: string
  enabled: boolean
  tools: McpToolInfo[]
}

type ExternalToolsState = {
  search: ExternalSearchConfig
  mcp: McpServerConfig[]
  ready: boolean
}

export class ExternalToolsConfigError extends Error {
  constructor(
    readonly code: 'searchUrl' | 'searchKey' | 'mcpName' | 'mcpUrl' | 'mcpToken' | 'mcpTools'
  ) {
    super(code)
    this.name = 'ExternalToolsConfigError'
  }
}

export const SEARCH_ENDPOINTS: Record<Exclude<ExternalSearchProvider, 'searxng'>, string> = {
  tavily: 'https://api.tavily.com',
  exa: 'https://api.exa.ai',
  brave: 'https://api.search.brave.com',
}

const SEARCH_PROVIDERS: ExternalSearchProvider[] = ['searxng', 'tavily', 'exa', 'brave']
const MAX_MCP_SERVERS = 10
const SERVER_ID = /^[A-Za-z0-9-]{1,80}$/
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '100.100.100.200',
  'metadata.google.internal',
  '::ffff:a9fe:a9fe',
  'fd00:ec2::254',
])

export const emptyExternalSearch = (): ExternalSearchConfig => ({
  enabled: false,
  provider: 'searxng',
  baseUrl: '',
  apiKey: '',
})

export const emptyExternalToolsState = (): ExternalToolsState => ({
  search: emptyExternalSearch(),
  mcp: [],
  ready: false,
})

export const useExternalTools = create<ExternalToolsState>(emptyExternalToolsState)

const hostBlocked = (hostname: string) => {
  return METADATA_HOSTS.has(hostname.toLowerCase()) || isBlockedExternalHostname(hostname)
}

const parseHttpsUrl = (value: string): URL | undefined => {
  const input = value.trim()
  if (!input || input.length > 2048 || hasControlCharacter(input) || input.includes('\\')) {
    return
  }
  let url: URL
  try {
    url = new URL(input)
  } catch {
    return
  }
  if (
    url.protocol !== 'https:' ||
    !url.hostname ||
    url.username ||
    url.password ||
    url.hash ||
    hostBlocked(url.hostname) ||
    url.search
  ) {
    return
  }
  return url
}

export const normalizeExternalSearchUrl = (value: string): string | undefined => {
  const url = parseHttpsUrl(value)
  if (!url) {
    return
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/search$/i, '')
  return `${url.origin}${path}`
}

const validKey = (value: string) => value.length <= 4096 && /^[\x21-\x7e]*$/.test(value)

export const isExternalSearchProvider = (value: unknown): value is ExternalSearchProvider =>
  SEARCH_PROVIDERS.includes(value as ExternalSearchProvider)

export const isExternalSearchConfigured = (config: ExternalSearchConfig) =>
  config.enabled &&
  (config.provider === 'searxng'
    ? !!normalizeExternalSearchUrl(config.baseUrl)
    : !!config.apiKey && validKey(config.apiKey))

export const normalizeExternalSearch = (config: ExternalSearchConfig): ExternalSearchConfig => {
  if (!isExternalSearchProvider(config.provider)) {
    throw new ExternalToolsConfigError('searchUrl')
  }
  const apiKey = config.apiKey.trim()
  if (!validKey(apiKey)) {
    throw new ExternalToolsConfigError('searchKey')
  }
  if (config.provider === 'searxng') {
    const baseUrl = normalizeExternalSearchUrl(config.baseUrl)
    if (!baseUrl) {
      throw new ExternalToolsConfigError('searchUrl')
    }
    return { enabled: config.enabled, provider: config.provider, baseUrl, apiKey }
  }
  if (!apiKey) {
    throw new ExternalToolsConfigError('searchKey')
  }
  return {
    enabled: config.enabled,
    provider: config.provider,
    baseUrl: SEARCH_ENDPOINTS[config.provider],
    apiKey,
  }
}

export const normalizeMcpUrl = (value: string): string | undefined => {
  const url = parseHttpsUrl(value)
  return url ? url.toString() : undefined
}

const validToolName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value)

const normalizeTool = (value: McpToolInfo): McpToolInfo | undefined => {
  if (!validToolName(value.name)) {
    return
  }
  const description = typeof value.description === 'string' ? value.description.slice(0, 1024) : ''
  const inputSchema =
    value.inputSchema && typeof value.inputSchema === 'object' && !Array.isArray(value.inputSchema)
      ? value.inputSchema
      : { type: 'object', properties: {} }
  try {
    if (JSON.stringify(inputSchema).length > 16 * 1024) {
      return
    }
  } catch {
    return
  }
  return {
    name: value.name,
    description,
    inputSchema,
    enabled: value.enabled !== false,
    readOnly: value.readOnly === true,
  }
}

export const normalizeMcpServer = (server: McpServerConfig): McpServerConfig => {
  if (!SERVER_ID.test(server.id)) {
    throw new ExternalToolsConfigError('mcpTools')
  }
  const name = server.name.trim()
  if (!name || name.length > 80 || hasControlCharacter(name)) {
    throw new ExternalToolsConfigError('mcpName')
  }
  const url = normalizeMcpUrl(server.url)
  if (!url) {
    throw new ExternalToolsConfigError('mcpUrl')
  }
  const token = server.token.trim()
  if (!validKey(token)) {
    throw new ExternalToolsConfigError('mcpToken')
  }
  if (!Array.isArray(server.tools)) {
    throw new ExternalToolsConfigError('mcpTools')
  }
  const tools = server.tools.flatMap((tool) => {
    const normalized = normalizeTool(tool)
    return normalized ? [normalized] : []
  })
  if (tools.length !== server.tools.length || tools.length > 100) {
    throw new ExternalToolsConfigError('mcpTools')
  }
  return {
    id: server.id,
    name,
    url,
    token,
    enabled: server.enabled !== false,
    tools,
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

export const readStoredExternalSearch = (value: unknown): ExternalSearchConfig => {
  if (!isRecord(value) || !isExternalSearchProvider(value.provider)) {
    return emptyExternalSearch()
  }
  const baseUrl = typeof value.baseUrl === 'string' ? value.baseUrl : ''
  const apiKey = typeof value.apiKey === 'string' ? value.apiKey : ''
  if (!validKey(apiKey)) {
    return emptyExternalSearch()
  }
  return {
    enabled: value.enabled === true,
    provider: value.provider,
    baseUrl:
      value.provider === 'searxng'
        ? (normalizeExternalSearchUrl(baseUrl) ?? '')
        : SEARCH_ENDPOINTS[value.provider],
    apiKey,
  }
}

export const readStoredMcpServers = (value: unknown): McpServerConfig[] => {
  if (!isRecord(value) || !Array.isArray(value.servers)) {
    return []
  }
  const ids = new Set<string>()
  return value.servers.flatMap((item): McpServerConfig[] => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      !SERVER_ID.test(item.id) ||
      ids.has(item.id) ||
      ids.size >= MAX_MCP_SERVERS
    ) {
      return []
    }
    try {
      const server = normalizeMcpServer({
        id: item.id,
        name: typeof item.name === 'string' ? item.name : '',
        url: typeof item.url === 'string' ? item.url : '',
        token: typeof item.token === 'string' ? item.token : '',
        enabled: item.enabled !== false,
        tools: Array.isArray(item.tools)
          ? item.tools.flatMap((tool): McpToolInfo[] => {
              if (!isRecord(tool)) {
                return []
              }
              return [
                {
                  name: typeof tool.name === 'string' ? tool.name : '',
                  description: typeof tool.description === 'string' ? tool.description : '',
                  inputSchema: isRecord(tool.inputSchema) ? tool.inputSchema : {},
                  enabled: tool.enabled !== false,
                  readOnly: tool.readOnly === true,
                },
              ]
            })
          : [],
      })
      ids.add(server.id)
      return [server]
    } catch {
      return []
    }
  })
}

const writeSlot = async (slot: 'externalSearch' | 'mcp', value: string) => {
  if (isNative) {
    await credentials.write({ slot, value })
  }
}

export const saveExternalSearch = async (config: ExternalSearchConfig) => {
  const normalized = normalizeExternalSearch(config)
  await writeSlot('externalSearch', JSON.stringify(normalized))
  useExternalTools.setState({ search: normalized })
}

export const saveMcpServers = async (servers: McpServerConfig[]) => {
  const normalized = servers.map(normalizeMcpServer)
  if (
    normalized.length > MAX_MCP_SERVERS ||
    new Set(normalized.map((server) => server.id)).size !== normalized.length
  ) {
    throw new ExternalToolsConfigError('mcpTools')
  }
  await writeSlot('mcp', JSON.stringify({ version: 1, servers: normalized }))
  useExternalTools.setState({ mcp: normalized })
}

export const initializeExternalTools = async (deadline: Promise<never>) => {
  if (!isNative) {
    useExternalTools.setState({ ready: true })
    return
  }
  try {
    const readSlot = async (slot: 'externalSearch' | 'mcp') => {
      const { value } = await Promise.race([credentials.read({ slot }), deadline])
      if (!value) {
        return null
      }
      try {
        return JSON.parse(value) as unknown
      } catch {
        return null
      }
    }
    const [search, mcp] = await Promise.all([readSlot('externalSearch'), readSlot('mcp')])
    useExternalTools.setState({
      search: search ? readStoredExternalSearch(search) : emptyExternalSearch(),
      mcp: mcp ? readStoredMcpServers(mcp) : [],
      ready: true,
    })
  } finally {
    useExternalTools.setState({ ready: true })
  }
}
