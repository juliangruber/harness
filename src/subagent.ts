import { runAgent, type AgentOptions } from './agent.ts'
import type { Message } from './llm.ts'
import type { Tool } from './tools.ts'

export type SubagentOptions = Pick<AgentOptions, 'client' | 'maxTurns' | 'onToolCall' | 'onMissingTool'> & {
  // Tools on top of the agent's own, like tool_search
  extraTools?: Tool[]
}

export type SubagentDefinition = {
  name: string
  description: string
  // The single string parameter the main agent fills in
  parameter: { name: string, description: string }
  prompt: () => string
  // A function loads tools when the agent first runs, like MCP tools
  tools: Tool[] | (() => Promise<Tool[]>)
  maxTurns: number
}

// A tool that delegates to a separate agent, so search results and pages
// don't fill up the main conversation
export function createSubagentTool (definition: SubagentDefinition, { maxTurns = definition.maxTurns, extraTools = [], ...options }: SubagentOptions): Tool {
  const { parameter } = definition
  return {
    name: definition.name,
    description: definition.description,
    parameters: {
      type: 'object',
      properties: { [parameter.name]: { type: 'string', description: parameter.description } },
      required: [parameter.name]
    },
    async run (args: Record<string, string>) {
      const messages: Message[] = [
        { role: 'system', content: definition.prompt() },
        { role: 'user', content: args[parameter.name] }
      ]
      const tools = typeof definition.tools === 'function' ? await definition.tools() : definition.tools
      const agentOptions = { ...options, tools: [...tools, ...extraTools], maxTurns }
      const answer = await runAgent(messages, agentOptions)
      if (extractUrls(answer).length) return answer

      messages.push({ role: 'user', content: 'List the URL of every source you used.' })
      return `${answer}\n\n${await runAgent(messages, agentOptions)}`
    }
  }
}

export function extractUrls (text: string): string[] {
  const urls = (text.match(/https?:\/\/[^\s<>"'`\]]+/g) ?? [])
    // Trailing punctuation and unbalanced closing parens belong to the sentence
    .map(url => url.replace(/[.,;:!?]+$/, ''))
    .map(url => url.endsWith(')') && !url.includes('(') ? url.replace(/\)+$/, '') : url)
  return [...new Set(urls)]
}

const appendList = (answer: string, items: string[], heading: string, moreHeading: string, isIncluded: (item: string) => boolean): string => {
  const missing = items.filter(item => !isIncluded(item))
  if (!missing.length) return answer
  return `${answer}\n\n${missing.length < items.length ? moreHeading : heading}\n${missing.map(item => `- ${item}`).join('\n')}`
}

// Makes sure every source ends up in the answer
export const appendSources = (answer: string, urls: string[]): string =>
  appendList(answer, urls, 'Sources:', 'More sources:', url => answer.includes(url))

// Headings of the sources and suggested web searches sections, in plain text
export const SECTION_HEADING = /^(more )?(sources|suggested web searches)\b[^:]*:?$/i

// Reads the queries listed under a "Suggested web searches:" heading. Models
// like to extend the heading, as in "Suggested web searches for current news:".
export function extractSearches (text: string): string[] {
  const lines = text.split('\n')
  const start = lines.findIndex(line => /^[#*_\s]*suggested web searches\b[^:]*:?[*_\s]*$/i.test(line))
  if (start === -1) return []
  const searches: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.+)$/)
    if (item) {
      searches.push(item[1].trim().replace(/^["'`“]+|["'`”]+$/g, ''))
    } else if (line.trim() || searches.length) {
      break
    }
  }
  return [...new Set(searches)]
}

// Makes sure every suggested web search ends up in the answer
export const appendSearches = (answer: string, searches: string[]): string =>
  appendList(answer, searches, 'Suggested web searches:', 'More suggested web searches:', search => answer.toLowerCase().includes(search.toLowerCase()))
