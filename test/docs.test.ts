import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createDocsTool } from '../src/docs.ts'
import type { ChatClient, Message, ToolSchema } from '../src/llm.ts'
import { createMcpToolLoader, type McpClient, type McpTool } from '../src/mcp.ts'
import type { McpServer } from '../src/mcp-servers.ts'

const server = (name: string, tools: string[]): McpServer => ({ name, url: `https://${name}.example/mcp`, fairness: 'test', tools })

// A fake MCP client that answers with its tool names
const fakeClient = (tools: string[]): McpClient => ({
  serverInfo: { name: 'fake' },
  listTools: async () => tools.map((name): McpTool => ({ name, description: `${name} tool`, inputSchema: { type: 'object' } })),
  callTool: async (name, args) => `${name} called with ${JSON.stringify(args)}`,
  close: async () => {}
})

test('mcp tool loader exposes reviewed tools, connects once and skips failing servers', async () => {
  const connects: string[] = []
  const errors: string[] = []
  const load = createMcpToolLoader([
    server('wiki', ['ask', 'read']),
    server('microsoft', ['microsoft_docs_search']),
    server('down', ['anything'])
  ], {
    connect: async url => {
      connects.push(url)
      if (url.includes('down')) throw new Error('offline')
      return url.includes('microsoft') ? fakeClient(['microsoft_docs_search']) : fakeClient(['ask', 'read', 'unreviewed'])
    },
    onError: (failed, err) => errors.push(`${failed.name}: ${err.message}`)
  })

  const tools = await load()
  await load()

  assert.deepEqual(tools.map(tool => tool.name), ['wiki_ask', 'wiki_read', 'microsoft_docs_search'])
  assert.equal(await tools[0].run({ q: 'hi' }), 'ask called with {"q":"hi"}')
  // Working servers connect once, failing ones are tried again
  assert.deepEqual(connects, ['https://wiki.example/mcp', 'https://microsoft.example/mcp', 'https://down.example/mcp', 'https://down.example/mcp'])
  assert.deepEqual(errors, ['down: offline', 'down: offline'])
})

test('docs runs a separate agent with MCP tools, loaded on first use', async () => {
  const calls: { messages: Message[], tools: ToolSchema[] }[] = []
  const client: ChatClient = {
    async chat (messages, tools) {
      calls.push({ messages: structuredClone(messages), tools })
      return { role: 'assistant', content: 'Use marked.parse(). https://context7.example/marked' }
    }
  }
  let connected = 0
  const docs = createDocsTool({
    client,
    servers: [server('context7', ['query-docs'])],
    connect: async () => { connected++; return fakeClient(['query-docs']) }
  })

  assert.equal(connected, 0)
  const answer = await docs.run({ question: 'How do I render markdown with marked?' })

  assert.equal(answer, 'Use marked.parse(). https://context7.example/marked')
  assert.equal(connected, 1)
  assert.match(calls[0].messages[0].content!, /documentation agent\. Today's date is \d{4}-\d{2}-\d{2}/)
  assert.deepEqual(calls[0].tools.map(tool => tool.function.name), ['context7_query-docs'])
})

test('docs fails clearly when no documentation server can be reached', async () => {
  const client: ChatClient = { chat: async () => ({ role: 'assistant', content: 'unused' }) }
  const docs = createDocsTool({ client, servers: [server('down', ['x'])], connect: async () => { throw new Error('offline') } })

  await assert.rejects(docs.run({ question: 'anything' }), /No documentation server could be reached/)
})
