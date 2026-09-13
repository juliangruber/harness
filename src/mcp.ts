// A small Model Context Protocol client for remote servers, over the
// Streamable HTTP transport: JSON-RPC over POST, answered with JSON or an
// event stream. https://modelcontextprotocol.io/specification/2025-06-18
import { request } from './http.ts'
import type { McpServer } from './mcp-servers.ts'
import type { Tool } from './tools.ts'

const PROTOCOL_VERSION = '2025-06-18'
const HINT = 'Try another tool instead.'
const MAX_OUTPUT = 30_000
const MAX_TOOL_PAGES = 10

export type McpTool = {
  name: string
  description?: string
  inputSchema: object
}

export type McpClient = {
  serverInfo: { name: string, version?: string }
  listTools (): Promise<McpTool[]>
  // Returns the tool's content as text, throws if the tool reports an error
  callTool (name: string, args?: object): Promise<string>
  close (): Promise<void>
}

export type McpOptions = {
  timeout?: number
}

type Message = {
  jsonrpc: '2.0'
  id?: number
  result?: any
  error?: { code: number, message: string }
}

export async function connectMcp (url: string, { timeout = 60_000 }: McpOptions = {}): Promise<McpClient> {
  let sessionId: string | undefined
  let protocolVersion: string | undefined
  let nextId = 1

  const post = async (message: object): Promise<Response> => {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream'
    }
    if (sessionId) headers['mcp-session-id'] = sessionId
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion
    const res = await request(url, { method: 'POST', body: JSON.stringify(message), headers, timeout, hint: HINT })
    sessionId = res.headers.get('mcp-session-id') ?? sessionId
    return res
  }

  const call = async (method: string, params: object = {}): Promise<any> => {
    const id = nextId++
    const res = await post({ jsonrpc: '2.0', id, method, params })
    const message = await readResponse(res, id)
    if (message.error) throw new Error(`MCP ${method} failed: ${message.error.message}`)
    return message.result
  }

  const notify = async (method: string): Promise<void> => {
    const res = await post({ jsonrpc: '2.0', method })
    await res.body?.cancel()
  }

  const initialized = await call('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'harness', version: '0.0.0' }
  })
  protocolVersion = initialized.protocolVersion ?? PROTOCOL_VERSION
  await notify('notifications/initialized')

  return {
    serverInfo: initialized.serverInfo ?? { name: new URL(url).hostname },

    async listTools () {
      const tools: McpTool[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const result = await call('tools/list', cursor ? { cursor } : {})
        tools.push(...(result.tools ?? []))
        cursor = result.nextCursor
        if (!cursor) break
      }
      return tools
    },

    async callTool (name, args = {}) {
      const result = await call('tools/call', { name, arguments: args })
      const text = formatContent(result)
      if (result.isError) throw new Error(text || `MCP tool ${name} failed`)
      return text
    },

    async close () {
      if (!sessionId) return
      try {
        const headers = { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion ?? PROTOCOL_VERSION }
        const res = await request(url, { method: 'DELETE', headers, allowErrors: true, hint: HINT })
        await res.body?.cancel()
      } catch {}
    }
  }
}

// Servers answer a request with JSON, or with an event stream that can carry
// other messages before the response
async function readResponse (res: Response, id: number): Promise<Message> {
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    for await (const message of eventStream(res)) {
      if (message.id === id && ('result' in message || 'error' in message)) return message
    }
    throw new Error('MCP server closed the stream without a response')
  }
  const body = await res.json()
  const message = (Array.isArray(body) ? body : [body]).find((m: Message) => m.id === id)
  if (!message) throw new Error('MCP server sent no response')
  return message
}

async function * eventStream (res: Response): AsyncGenerator<Message> {
  if (!res.body) return
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''

  const parse = (event: string): Message | undefined => {
    const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n')
    if (!data) return
    try {
      return JSON.parse(data)
    } catch {}
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += value
      let match: RegExpMatchArray | null
      while ((match = buffer.match(/\r?\n\r?\n/))) {
        const message = parse(buffer.slice(0, match.index))
        buffer = buffer.slice(match.index! + match[0].length)
        if (message) yield message
      }
    }
    const last = parse(buffer)
    if (last) yield last
  } finally {
    reader.cancel().catch(() => {})
  }
}

function formatContent (result: any): string {
  const parts = (result.content ?? []).map((item: any) => {
    switch (item.type) {
      case 'text': return item.text
      case 'resource_link': return `${item.name ? `${item.name}: ` : ''}${item.uri}`
      case 'resource': return item.resource?.text ?? item.resource?.uri ?? ''
      default: return `[${item.type}${item.mimeType ? ` ${item.mimeType}` : ''}]`
    }
  })
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2))
  const text = parts.join('\n\n')
  return text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT)}\n[truncated ${text.length - MAX_OUTPUT} chars]` : text
}

// Harness tools for an MCP server's tools, like deepwiki_ask_question. Names
// that already start with the prefix, like microsoft_docs_search, stay as is.
export function mcpTools (client: McpClient, prefix: string, tools: McpTool[], rename: Record<string, string> = {}): Tool[] {
  return tools.map(tool => ({
    name: (rename[tool.name] ?? (tool.name.startsWith(`${prefix}_`) ? tool.name : `${prefix}_${tool.name}`)).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
    description: tool.description ?? '',
    parameters: tool.inputSchema ?? { type: 'object' },
    run: (args: object) => client.callTool(tool.name, args)
  }))
}

export type LazyMcpToolOptions = {
  server: McpServer
  // The tool's name on the server, it must be a reviewed tool
  tool: string
  // Name, description and input schema the model sees, known without connecting
  name: string
  description: string
  parameters: object
  connect?: (url: string) => Promise<McpClient>
}

// An MCP tool that only contacts its server when the model calls it
export function createLazyMcpTool ({ server, tool, name, description, parameters, connect = connectMcp }: LazyMcpToolOptions): Tool {
  if (!server.tools.includes(tool)) throw new Error(`${tool} isn't a reviewed tool of MCP server ${server.name}`)
  let client: Promise<McpClient> | undefined
  return {
    name,
    description,
    parameters,
    async run (args: object) {
      // A failed connection is tried again on the next call
      client ??= connect(server.url).catch(err => {
        client = undefined
        throw err
      })
      return (await client).callTool(tool, args)
    }
  }
}

export type McpToolLoaderOptions = {
  connect?: (url: string) => Promise<McpClient>
  // A server couldn't be reached, its tools are left out this time
  onError?: (server: McpServer, error: Error) => void
}

// Connects to servers on first use and keeps the connection. Only reviewed
// tools are exposed. Failed servers are tried again on the next load.
export function createMcpToolLoader (servers: McpServer[], { connect = connectMcp, onError }: McpToolLoaderOptions = {}): () => Promise<Tool[]> {
  const loaded = new Map<string, Promise<Tool[]>>()

  const load = async (server: McpServer): Promise<Tool[]> => {
    const client = await connect(server.url)
    const tools = (await client.listTools()).filter(tool => server.tools.includes(tool.name))
    return mcpTools(client, server.name, tools, server.rename)
  }

  return async () => {
    const results = await Promise.all(servers.map(server => {
      let tools = loaded.get(server.url)
      if (!tools) {
        tools = load(server)
        loaded.set(server.url, tools)
      }
      return tools.catch(err => {
        loaded.delete(server.url)
        onError?.(server, err instanceof Error ? err : new Error(String(err)))
        return []
      })
    }))
    return results.flat()
  }
}
