import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, type IncomingHttpHeaders } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connectMcp, mcpTools } from '../src/mcp.ts'

type Recorded = { method: string, headers: IncomingHttpHeaders, body: any }

// A fake MCP server over Streamable HTTP, answering with JSON or event streams
async function fakeMcpServer (t: TestContext, { stream }: { stream: boolean }) {
  const requests: Recorded[] = []
  const server = createServer(async (req, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = raw ? JSON.parse(raw) : undefined
    requests.push({ method: req.method!, headers: req.headers, body })

    if (req.method === 'DELETE' || body.id === undefined) {
      res.statusCode = req.method === 'DELETE' ? 200 : 202
      return res.end()
    }

    let message: object
    switch (body.method) {
      case 'initialize':
        res.setHeader('mcp-session-id', 'session-1')
        message = { result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1.0.0' } } }
        break
      case 'tools/list':
        message = body.params.cursor
          ? { result: { tools: [{ name: 'fail', inputSchema: { type: 'object' } }] } }
          : { result: { tools: [{ name: 'ask question', description: 'Ask about docs', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } }], nextCursor: 'page-2' } }
        break
      case 'tools/call':
        if (body.params.name === 'fail') message = { result: { isError: true, content: [{ type: 'text', text: 'boom' }] } }
        else if (body.params.name === 'unknown') message = { error: { code: -32602, message: 'Unknown tool: unknown' } }
        else message = { result: { content: [{ type: 'text', text: `Answer to ${body.params.arguments.q}` }, { type: 'resource_link', uri: 'https://docs.example/a', name: 'Doc A' }] } }
        break
      default:
        message = { error: { code: -32601, message: 'Method not found' } }
    }

    const response = JSON.stringify({ jsonrpc: '2.0', id: body.id, ...message })
    if (stream) {
      res.setHeader('content-type', 'text/event-stream')
      // Servers may send notifications before the response
      res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } })}\n\n`)
      res.end(`event: message\ndata: ${response}\n\n`)
    } else {
      res.setHeader('content-type', 'application/json')
      res.end(response)
    }
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, requests }
}

for (const stream of [false, true]) {
  test(`mcp client initializes, lists and calls tools (${stream ? 'event stream' : 'json'})`, async t => {
    const server = await fakeMcpServer(t, { stream })

    const client = await connectMcp(server.url)
    const tools = await client.listTools()
    const answer = await client.callTool('ask question', { q: 'setup' })
    await client.close()

    assert.deepEqual(client.serverInfo, { name: 'fake', version: '1.0.0' })
    assert.deepEqual(tools.map(tool => tool.name), ['ask question', 'fail'])
    assert.equal(answer, 'Answer to setup\n\nDoc A: https://docs.example/a')

    const [initialize, initialized, ...rest] = server.requests
    assert.equal(initialize.body.method, 'initialize')
    assert.equal(initialize.headers['mcp-session-id'], undefined)
    assert.match(String(initialize.headers.accept), /application\/json, text\/event-stream/)
    assert.equal(initialized.body.method, 'notifications/initialized')
    for (const request of [initialized, ...rest]) {
      assert.equal(request.headers['mcp-session-id'], 'session-1')
      assert.equal(request.headers['mcp-protocol-version'], '2025-06-18')
    }
    assert.equal(rest.at(-1)!.method, 'DELETE')
  })
}

test('mcp client reports tool and protocol errors', async t => {
  const server = await fakeMcpServer(t, { stream: false })
  const client = await connectMcp(server.url)

  // The tool ran and reported an error
  await assert.rejects(client.callTool('fail'), /^Error: boom$/)
  // The server refused the request
  await assert.rejects(client.callTool('unknown'), /^Error: MCP tools\/call failed: Unknown tool: unknown$/)
})

test('mcp tools become harness tools with prefixed, valid names', async t => {
  const server = await fakeMcpServer(t, { stream: true })
  const client = await connectMcp(server.url)

  const tools = mcpTools(client, 'docs', await client.listTools())

  assert.deepEqual(tools.map(tool => tool.name), ['docs_ask_question', 'docs_fail'])
  assert.equal(tools[0].description, 'Ask about docs')
  assert.equal(await tools[0].run({ q: 'install' }), 'Answer to install\n\nDoc A: https://docs.example/a')
})
