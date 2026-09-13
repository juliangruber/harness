// The docs agent answers questions about software from documentation MCP
// servers, see mcp-servers.ts for the list and why each one is fair.
import { createMcpToolLoader, type McpToolLoaderOptions } from './mcp.ts'
import { docsServers, type McpServer } from './mcp-servers.ts'
import { createSubagentTool, type SubagentOptions } from './subagent.ts'
import type { Tool } from './tools.ts'

export const docsPrompt = (date = new Date()): string =>
  `You are a documentation agent. Today's date is ${date.toLocaleDateString('en-CA')}.
Answer questions about software libraries, frameworks, GitHub repositories and Microsoft products using the tools: DeepWiki (documentation of public GitHub repositories), Context7 (up to date library documentation) and Microsoft Learn. APIs change, so look them up instead of relying on memory. If a tool fails, move on to another tool instead of retrying it.
Reply with a concise answer, with code examples where useful, followed by a "Sources" list with the URLs of the documentation you used. If the documentation doesn't answer the question, say so.`

export type DocsOptions = SubagentOptions & McpToolLoaderOptions & {
  servers?: McpServer[]
}

export function createDocsTool ({ servers = docsServers, connect, onError, ...options }: DocsOptions): Tool {
  const loadTools = createMcpToolLoader(servers, { connect, onError })
  return createSubagentTool({
    name: 'docs',
    description: 'Ask a documentation agent about software libraries, frameworks, GitHub repositories and Microsoft products. It reads current documentation, so use it for APIs and usage you are unsure about. Returns an answer with source URLs, include them in your answer.',
    parameter: { name: 'question', description: 'A self-contained question, including library names and versions' },
    prompt: () => docsPrompt(),
    tools: async () => {
      const tools = await loadTools()
      if (!tools.length) throw new Error('No documentation server could be reached. Answer without docs, and say so.')
      return tools
    },
    maxTurns: 15
  }, options)
}
