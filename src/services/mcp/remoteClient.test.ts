import assert from 'node:assert/strict'
import { test } from 'node:test'
import { RemoteMcpClient, type ExternalHttpTransport } from './remoteClient.js'
import type { ExternalHttpResult } from '../tools/http.js'

type RpcBody = {
  jsonrpc?: unknown
  id?: number
  method?: string
  params?: Record<string, unknown>
}

const signal = () => new AbortController().signal

const json = (
  id: number,
  result: unknown,
  headers: Record<string, string> = {}
): ExternalHttpResult => ({
  status: 200,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ jsonrpc: '2.0', id, result }),
})

const bodyOf = (options: { body?: string }): RpcBody => JSON.parse(options.body ?? '{}') as RpcBody

test('initializes a session, lists paginated tools and calls one with an explicit read-only hint', async () => {
  const requests: Parameters<ExternalHttpTransport>[0][] = []
  let initializeCalls = 0
  const transport: ExternalHttpTransport = async (options) => {
    requests.push(options)
    const body = bodyOf(options)
    switch (body.method) {
      case 'initialize':
        initializeCalls++
        return json(
          body.id as number,
          {
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
          { 'Mcp-Session-Id': 'session-1' }
        )
      case 'notifications/initialized':
        return { status: 202, headers: {}, body: '' }
      case 'tools/list':
        return json(body.id as number, {
          tools: [
            {
              name: 'read_page',
              description: 'Read a page',
              inputSchema: {
                type: 'object',
                properties: { url: { type: 'string' } },
                required: ['url'],
              },
              annotations: { readOnlyHint: true, destructiveHint: false },
            },
            {
              name: 'delete_page',
              inputSchema: { type: 'object', properties: {} },
              annotations: { readOnlyHint: true, destructiveHint: true },
            },
          ],
        })
      case 'tools/call':
        return json(body.id as number, {
          content: [{ type: 'text', text: 'page body' }],
          isError: false,
        })
      default:
        throw new Error(`unexpected method ${body.method}`)
    }
  }
  const client = new RemoteMcpClient(
    { url: 'https://mcp.example.com/rpc', token: 'fixture-token' },
    transport
  )

  const tools = await client.listTools({ signal: signal() })
  assert.deepEqual(
    tools.map((tool) => [tool.name, tool.readOnly]),
    [
      ['read_page', true],
      ['delete_page', false],
    ]
  )
  const result = await client.callTool(
    'read_page',
    { url: 'https://example.com' },
    { signal: signal() }
  )
  assert.equal(result.content, 'page body')
  assert.equal(result.isError, false)
  assert.equal(initializeCalls, 1)

  const list = requests.find((request) => bodyOf(request).method === 'tools/list')
  assert.ok(list)
  assert.equal(list.url, 'https://mcp.example.com/rpc')
  assert.equal(list.headers?.Authorization, 'Bearer fixture-token')
  assert.equal(list.headers?.['Mcp-Session-Id'], 'session-1')
  assert.equal(list.headers?.['MCP-Protocol-Version'], '2025-03-26')
  assert.equal(list.body?.includes('fixture-token'), false)
  const call = requests.find((request) => bodyOf(request).method === 'tools/call')
  assert.ok(call)
  assert.deepEqual(bodyOf(call).params, {
    name: 'read_page',
    arguments: { url: 'https://example.com' },
  })
  assert.equal(call.url.includes('fixture-token'), false)
})

test('parses SSE responses and recreates an expired session before retrying', async () => {
  let initializeCalls = 0
  let listCalls = 0
  const sessions: string[] = []
  const transport: ExternalHttpTransport = async (options) => {
    const body = bodyOf(options)
    switch (body.method) {
      case 'initialize': {
        initializeCalls++
        const session = `session-${initializeCalls}`
        sessions.push(session)
        return json(
          body.id as number,
          { protocolVersion: '2025-03-26' },
          {
            'Mcp-Session-Id': session,
          }
        )
      }
      case 'notifications/initialized':
        return { status: 202, headers: {}, body: '' }
      case 'tools/list':
        listCalls++
        if (listCalls === 1) {
          return { status: 404, headers: {}, body: '' }
        }
        return {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
          body: `event: message\ndata: ${JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              tools: [
                {
                  name: 'lookup',
                  inputSchema: { type: 'object', properties: {} },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          })}\n\n`,
        }
      default:
        throw new Error(`unexpected method ${body.method}`)
    }
  }
  const client = new RemoteMcpClient(
    { url: 'https://mcp.example.com/rpc', token: 'fixture-token' },
    transport
  )

  assert.deepEqual(
    (await client.listTools({ signal: signal() })).map((tool) => tool.name),
    ['lookup']
  )
  assert.equal(initializeCalls, 2)
  assert.equal(listCalls, 2)
  assert.deepEqual(sessions, ['session-1', 'session-2'])
})

test('reports protocol, cancellation and redacted server failures', async () => {
  const token = 'top-secret-token'
  const transport: ExternalHttpTransport = async (options) => {
    const body = bodyOf(options)
    if (body.method === 'initialize') {
      return json(body.id as number, { protocolVersion: '2025-03-26' })
    }
    if (body.method === 'notifications/initialized') {
      return { status: 202, headers: {}, body: '' }
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: `server rejected ${token}` },
      }),
    }
  }
  const client = new RemoteMcpClient({ url: 'https://mcp.example.com/rpc', token }, transport)
  await assert.rejects(
    client.listTools({ signal: signal() }),
    (error: unknown) =>
      error instanceof Error &&
      error.name === 'McpError' &&
      error.message.includes('[redacted]') &&
      !error.message.includes(token)
  )

  const aborted = new AbortController()
  aborted.abort()
  await assert.rejects(
    new RemoteMcpClient({ url: 'https://mcp.example.com/rpc' }).listTools({
      signal: aborted.signal,
    }),
    { name: 'AbortError' }
  )

  const malformed = new RemoteMcpClient({ url: 'https://mcp.example.com/rpc' }, async (options) => {
    const body = bodyOf(options)
    return body.method === 'initialize'
      ? json(body.id as number, { protocolVersion: '2025-03-26' })
      : { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' }
  })
  await assert.rejects(
    malformed.listTools({ signal: signal() }),
    (error: unknown) => error instanceof Error && error.name === 'McpError'
  )
})

test('redacts short server tokens from error messages', async () => {
  const transport: ExternalHttpTransport = async (options) => {
    const body = bodyOf(options)
    if (body.method === 'initialize') {
      return json(body.id as number, { protocolVersion: '2025-03-26' })
    }
    if (body.method === 'notifications/initialized') {
      return { status: 202, headers: {}, body: '' }
    }
    return {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        error: { code: -32000, message: 'rejected abc' },
      }),
    }
  }
  const client = new RemoteMcpClient(
    { url: 'https://mcp.example.com/rpc', token: 'abc' },
    transport
  )
  await assert.rejects(
    client.listTools({ signal: signal() }),
    (error: unknown) =>
      error instanceof Error &&
      error.message.includes('[redacted]') &&
      !error.message.includes('abc')
  )
})
