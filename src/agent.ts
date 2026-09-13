import type { ChatClient, Message, ToolCall } from './llm.ts'
import type { Instructions } from './instructions.ts'
import { UNAVAILABLE_TOOLS, type Tool } from './tools.ts'

export type AgentOptions = {
  client: ChatClient
  tools: Tool[]
  maxTurns?: number
  onToolCall?: (call: ToolCall) => void
  onToolResult?: (call: ToolCall, result: string) => void
  // Called when the model requests a tool that doesn't exist (yet), with
  // existing tools it might have meant
  onMissingTool?: (call: ToolCall, suggestions: string[]) => void
}

export type SystemPromptOptions = {
  // Whether bash commands are checked before they run, see bashreview.ts
  bashReview?: boolean
  // Whether file tools are limited to the working directory
  restrictFiles?: boolean
}

export function systemPrompt (cwd = process.cwd(), instructions?: Instructions, { bashReview = true, restrictFiles = true }: SystemPromptOptions = {}): string {
  const files = restrictFiles ? ' File tools only access files inside it.' : ''
  const bash = bashReview
    ? 'Prefer the dedicated tools over bash: every bash call makes an extra round trip, in which a separate check reviews whether the other tools could do the same and whether the command is safe to run. Commands failing the check are refused.'
    : 'Prefer the dedicated tools over bash.'
  const prompt = `You are a helpful assistant running on the user's computer. The working directory is ${cwd}.${files} Today's date is ${new Date().toLocaleDateString('en-CA')}.
Answer any question or request. Not every request is about code: answer general questions directly, without commenting on what kind of session this is. When it helps, use the tools to read and write files or run commands, and keep going until the request is done. ${bash}
If none of your tools fit, use tool_search to find more. These tools are known to be unavailable, don't search for them: ${UNAVAILABLE_TOOLS.join(', ')}.
If you'd recommend follow-up web searches to the user, end your answer with a "Suggested web searches:" list of search queries.`
  return instructions
    ? `${prompt}\n\nInstructions from ${instructions.path}:\n${instructions.content}`
    : prompt
}

// Runs the model until it replies without tool calls. Appends every message
// to `messages`, so calling it again continues the conversation.
export async function runAgent (messages: Message[], { client, tools, maxTurns = 50, onToolCall, onToolResult, onMissingTool }: AgentOptions): Promise<string> {
  const schemas = tools.map(({ name, description, parameters }) => ({
    type: 'function' as const,
    function: { name, description, parameters }
  }))

  for (let turn = 0; turn < maxTurns; turn++) {
    const reply = await client.chat(messages, schemas)
    messages.push(reply)
    if (!reply.tool_calls) return reply.content ?? ''

    for (const call of reply.tool_calls) {
      onToolCall?.(call)
      const tool = tools.find(t => t.name === call.function.name)
      let content: string
      if (tool) {
        content = await runTool(tool, call)
      } else {
        const suggestions = similarTools(call.function.name, tools)
        onMissingTool?.(call, suggestions)
        content = suggestions.length
          ? `Error: unknown tool ${call.function.name}. Did you mean: ${suggestions.join(', ')}? Otherwise use tool_search to find more tools.`
          : `Error: unknown tool ${call.function.name}. Use tool_search to find more tools.`
      }
      onToolResult?.(call, content)
      messages.push({ role: 'tool', tool_call_id: call.id, content })
    }
  }
  throw new Error(`Stopped after ${maxTurns} turns`)
}

// Words many tool names share, which say nothing about what a tool is for
const GENERIC_WORDS = new Set(['search', 'find', 'get', 'read', 'list', 'fetch', 'query', 'tool', 'run', 'call'])

const meaningfulWords = (name: string): Set<string> => new Set(name
  .toLowerCase()
  .split(/[^a-z0-9]+/)
  .map(word => word.replace(/s$/, ''))
  .filter(word => word.length > 1 && !GENERIC_WORDS.has(word)))

// Existing tools sharing the most meaningful words with a made up tool name,
// like search_papers for search_paper_query
export function similarTools (name: string, tools: Tool[]): string[] {
  const wanted = meaningfulWords(name)
  const scored = tools
    .filter(tool => tool.name !== 'tool_search')
    .map(tool => ({ name: tool.name, score: [...meaningfulWords(tool.name)].filter(word => wanted.has(word)).length }))
    .filter(tool => tool.score > 0)
  const best = Math.max(0, ...scored.map(tool => tool.score))
  return scored.filter(tool => tool.score === best).slice(0, 3).map(tool => tool.name)
}

// Errors go back to the model as text so it can recover
async function runTool (tool: Tool, call: ToolCall): Promise<string> {
  try {
    return await tool.run(JSON.parse(call.function.arguments || '{}'))
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}
