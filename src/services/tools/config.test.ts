import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ExternalToolsConfigError,
  normalizeExternalSearch,
  normalizeExternalSearchUrl,
  normalizeMcpServer,
  normalizeMcpUrl,
} from './config.js'
import { validateExternalUrl } from './http.js'

const server = {
  id: 'server-1',
  name: 'Example MCP',
  url: 'https://mcp.example.com/mcp',
  token: 'fixture-token',
  enabled: true,
  tools: [
    {
      name: 'read_page',
      description: 'Read a page',
      inputSchema: { type: 'object', properties: { url: { type: 'string' } } },
      enabled: true,
      readOnly: true,
    },
  ],
}

test('accepts only public HTTPS endpoints without embedded secrets', () => {
  for (const url of [
    'http://mcp.example.com/mcp',
    'https://user:password@mcp.example.com/mcp',
    'https://mcp.example.com/mcp?token=secret',
    'https://mcp.example.com/mcp#fragment',
    'https://localhost/mcp',
    'https://metadata.google.internal/mcp',
    'https://127.0.0.1/mcp',
    'https://10.0.0.1/mcp',
    'https://172.16.0.1/mcp',
    'https://172.31.255.255/mcp',
    'https://192.168.1.1/mcp',
    'https://100.64.0.1/mcp',
    'https://169.254.169.254/latest/meta-data',
    'https://[::1]/mcp',
    'https://[fc00::1]/mcp',
    'https://[fe80::1]/mcp',
    'https://[::ffff:7f00:1]/mcp',
  ]) {
    assert.equal(normalizeMcpUrl(url), undefined, url)
    assert.throws(() => validateExternalUrl(url), { name: 'ExternalHttpError' }, url)
  }

  assert.equal(normalizeMcpUrl('https://mcp.example.com/mcp'), 'https://mcp.example.com/mcp')
  assert.equal(normalizeMcpUrl('https://mcp.example.com/mcp?mode=read'), undefined)
  assert.equal(validateExternalUrl('https://mcp.example.com/mcp?mode=read').search, '?mode=read')
  assert.equal(normalizeExternalSearchUrl('https://search.example.com/?q=x'), undefined)
  assert.equal(
    normalizeExternalSearchUrl('https://search.example.com/base/search/'),
    'https://search.example.com/base'
  )
})

test('validates search credentials and normalizes MCP configuration', () => {
  assert.deepEqual(
    normalizeExternalSearch({
      enabled: true,
      provider: 'tavily',
      baseUrl: 'https://ignored.example.com',
      apiKey: '  key-1  ',
    }),
    {
      enabled: true,
      provider: 'tavily',
      baseUrl: 'https://api.tavily.com',
      apiKey: 'key-1',
    }
  )
  assert.throws(
    () =>
      normalizeExternalSearch({
        enabled: true,
        provider: 'searxng',
        baseUrl: 'http://search.example.com',
        apiKey: '',
      }),
    (error: unknown) => error instanceof ExternalToolsConfigError && error.code === 'searchUrl'
  )
  assert.throws(
    () =>
      normalizeExternalSearch({
        enabled: true,
        provider: 'brave',
        baseUrl: '',
        apiKey: 'bad key',
      }),
    (error: unknown) => error instanceof ExternalToolsConfigError && error.code === 'searchKey'
  )

  assert.deepEqual(normalizeMcpServer(server), server)
  assert.throws(
    () => normalizeMcpServer({ ...server, url: 'https://10.0.0.2/mcp' }),
    (error: unknown) => error instanceof ExternalToolsConfigError && error.code === 'mcpUrl'
  )
  assert.throws(
    () => normalizeMcpServer({ ...server, token: 'bad token' }),
    (error: unknown) => error instanceof ExternalToolsConfigError && error.code === 'mcpToken'
  )
})
