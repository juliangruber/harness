// Remote MCP servers the harness uses. Each one is reviewed for fairness: the
// operator's income doesn't depend on ads or human visits to the content.

export type McpServer = {
  // Prefix for the server's tool names
  name: string
  url: string
  // Why using the server is fair
  fairness: string
  // Reviewed tools. Tools the server adds later stay hidden until reviewed.
  tools: string[]
  // Names to expose tools under, instead of the prefixed server names
  rename?: Record<string, string>
}

// Reviewed and left out:
// - Manifold (api.manifold.markets/v0/mcp): decided against it
// - Exa (mcp.exa.ai): web search, returns content from ad funded websites
// - GitMCP's fetch_generic_url_content: reads any URL, like the unavailable "fetch web page" tool

export const researchServers: McpServer[] = [
  {
    name: 'wolfram',
    url: 'https://agenttools.wolfram.com/mcp',
    fairness: 'Wolfram|Alpha is free and funded by Pro subscriptions, apps, paid APIs and enterprise versions, not ads. The cloud MCP service is free for limited personal use, so it is only contacted for maths questions. Code execution (WolframLanguageEvaluator) is left out, since it costs Wolfram compute.',
    tools: ['WolframAlpha']
  }
]

export const docsServers: McpServer[] = [
  {
    name: 'deepwiki',
    url: 'https://mcp.deepwiki.com/mcp',
    fairness: 'Run by Cognition (Devin) as a free service for agents. Documentation generated from public GitHub repositories, no ads.',
    tools: ['read_wiki_structure', 'read_wiki_contents', 'ask_question']
  },
  {
    name: 'context7',
    url: 'https://mcp.context7.com/mcp',
    fairness: 'Run by Upstash, funded by paid plans. Library documentation made for agents, no ads.',
    tools: ['resolve-library-id', 'query-docs']
  },
  {
    name: 'microsoft',
    url: 'https://learn.microsoft.com/api/mcp',
    fairness: 'Microsoft\'s own product documentation, offered to agents by Microsoft. Documentation supports its products, not ads.',
    tools: ['microsoft_docs_search', 'microsoft_code_sample_search', 'microsoft_docs_fetch']
  }
]
