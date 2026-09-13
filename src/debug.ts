import { stderr } from 'node:process'
import { styleText } from 'node:util'
import type { ChatClient, Message, ToolSchema } from './llm.ts'
import { renderMarkdown } from './markdown.ts'

export type DebugOptions = {
  // Prefix for headers, to tell nested agents apart
  label?: string
  log?: (text: string) => void
}

type Format = Parameters<typeof styleText>[0]

const style = (format: Format, text: string) => styleText(format, text, { stream: stderr })

const indent = (text: string, spaces: number) =>
  text.split('\n').map(line => line && ' '.repeat(spaces) + line).join('\n')

// Printed between the debug log and the rendered answer
export const answerSeparator = (): string => `${style(['bold', 'magenta'], '=== answer ===')}\n`

// Tool arguments as `key: value` lines, multi-line values indented below
function formatArguments (args: string): string {
  let parsed: unknown
  try {
    parsed = JSON.parse(args || '{}')
  } catch {
    return indent(args, 2)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return indent(JSON.stringify(parsed, null, 2), 2)
  return Object.entries(parsed).map(([key, value]) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text.includes('\n')
      ? `  ${style('dim', `${key}:`)}\n${indent(text, 4)}`
      : `  ${style('dim', `${key}:`)} ${text}`
  }).join('\n')
}

function formatResult (content: string): string {
  if (/^\s*[[{]/.test(content)) {
    try {
      return JSON.stringify(JSON.parse(content), null, 2)
    } catch {}
  }
  return content
}

// Wraps a client to log everything exchanged with the model, including
// implicit context like the system prompt, tool definitions and tool results
export function withDebug (client: ChatClient, { label, log = text => { stderr.write(text) } }: DebugOptions = {}): ChatClient {
  const seen = new WeakSet<Message>()
  const toolNames = new Map<string, string>()
  let toolsLogged = false

  const header = (text: string) => style(['bold', 'magenta'], `--- ${label ? `${label}: ` : ''}${text} ---`)

  const formatMessage = (message: Message): string => {
    const lines: string[] = []
    if (message.role === 'tool') {
      const name = toolNames.get(message.tool_call_id)
      lines.push(header(`tool result: ${name ? `${name} ` : ''}${message.tool_call_id}`), formatResult(message.content))
    } else {
      lines.push(header(message.role))
      if (message.content) lines.push(renderMarkdown(message.content, { stream: stderr }))
      if (message.role === 'assistant') {
        for (const call of message.tool_calls ?? []) {
          toolNames.set(call.id, call.function.name)
          lines.push(`${style(['bold', 'cyan'], call.function.name)} ${style('dim', call.id)}`)
          const args = formatArguments(call.function.arguments)
          if (args) lines.push(args)
        }
      }
    }
    return `${lines.join('\n')}\n`
  }

  const formatTools = (tools: ToolSchema[]): string =>
    `${[header('tools'), ...tools.map(({ function: f }) => `${style('bold', f.name)}: ${f.description}`)].join('\n')}\n`

  return {
    async chat (messages, tools) {
      if (!toolsLogged && tools.length) {
        log(formatTools(tools))
        toolsLogged = true
      }
      for (const message of messages) {
        if (seen.has(message)) continue
        seen.add(message)
        log(formatMessage(message))
      }
      const reply = await client.chat(messages, tools)
      seen.add(reply)
      log(formatMessage(reply))
      return reply
    }
  }
}
