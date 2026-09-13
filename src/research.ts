import { connectMcp, createLazyMcpTool, type McpClient } from './mcp.ts'
import { researchServers } from './mcp-servers.ts'
import { sourceTools } from './sources.ts'
import { createSubagentTool, type SubagentOptions } from './subagent.ts'
import type { Tool } from './tools.ts'

export const researchPrompt = (date = new Date()): string =>
  `You are a research agent. Today's date is ${date.toLocaleDateString('en-CA')}.
Answer the question using the tools: Wikipedia, Wikidata and scholarly paper databases. Search first, then read the most relevant results. Don't rely on memory for facts you can look up. Paper tools only return abstracts, not full papers, so say when a claim is based on an abstract. Sources can be unavailable or rate limited: if a tool fails, move on to another source instead of retrying it.
Only use wolfram_alpha when the question is about mathematics, like calculations, equations or statistics. Never use it for other facts.
Reply with a concise answer, followed by a "Sources" list with the URL of every source you used. If the sources don't answer the question, say so.
If a regular web search would help the user learn more, for example about news, prices, opinions or anything your sources don't cover, end with a "Suggested web searches:" list of search queries. Leave it out if you have none.`

export type ResearchOptions = SubagentOptions & {
  connect?: (url: string) => Promise<McpClient>
}

export function createResearchTool ({ connect = connectMcp, ...options }: ResearchOptions): Tool {
  const wolfram = researchServers.find(server => server.name === 'wolfram')!
  // Wolfram is only contacted when the model calls this tool, for maths
  const wolframAlpha = createLazyMcpTool({
    server: wolfram,
    tool: 'WolframAlpha',
    name: 'wolfram_alpha',
    description: 'Compute answers to mathematics questions with Wolfram|Alpha: calculations, equations, statistics. Only use it for maths.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'Wolfram Alpha query, like "integrate x^2 sin(x)"' } },
      required: ['query']
    },
    connect
  })

  return createSubagentTool({
    name: 'research',
    description: 'Ask a research agent that searches Wikipedia, Wikidata and scholarly papers, and computes maths with Wolfram|Alpha. Returns a concise answer with source URLs, and sometimes suggested web searches. Use it for facts you are unsure about or that may have changed. Include the source URLs and suggested web searches in your answer.',
    parameter: { name: 'question', description: 'A self-contained question, including all needed context' },
    prompt: () => researchPrompt(),
    tools: [...sourceTools, wolframAlpha],
    maxTurns: 15
  }, options)
}
