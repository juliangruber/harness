import { randomUUID } from 'node:crypto'

export type ToolCall = {
  id: string
  type: 'function'
  function: { name: string, arguments: string }
}

export type AssistantMessage = {
  role: 'assistant'
  content: string | null
  tool_calls?: ToolCall[]
}

export type Message =
  | { role: 'system' | 'user', content: string }
  | AssistantMessage
  | { role: 'tool', tool_call_id: string, content: string }

export type ToolSchema = {
  type: 'function'
  function: { name: string, description: string, parameters: object }
}

export interface ChatClient {
  chat (messages: Message[], tools: ToolSchema[]): Promise<AssistantMessage>
}

export type ClientOptions = {
  baseUrl: string
  model: string
  apiKey?: string
  // How often to retry server errors, defaults to 2
  retries?: number
  onRetry?: (error: Error) => void
}

// Speaks the OpenAI compatible /v1/chat/completions API
// (Ollama, llama.cpp, vLLM, LM Studio, OpenRouter, ...)
export function createClient ({ baseUrl, model, apiKey, retries = 2, onRetry }: ClientOptions): ChatClient {
  return {
    async chat (messages, tools) {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
          },
          body: JSON.stringify({
            model,
            messages,
            tools: tools.length ? tools : undefined
          })
        })
        if (res.ok) {
          const body = await res.json() as { choices: { message: any }[] }
          return normalize(body.choices[0].message)
        }
        const error = new Error(`LLM request failed: ${res.status} ${res.statusText} ${await res.text()}`)
        // Server errors are often the server failing to parse sampled model
        // output, like a malformed tool call, so a retry usually works
        if (res.status < 500 || attempt >= retries) throw error
        onRetry?.(error)
      }
    }
  }
}

// Servers differ slightly: some omit tool call ids or send arguments as
// objects. Also drops extra fields (like `reasoning`) so they are not sent back.
function normalize (message: any): AssistantMessage {
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((call: any) => ({
    id: call.id || `call_${randomUUID()}`,
    type: 'function',
    function: {
      name: call.function.name,
      arguments: typeof call.function.arguments === 'string'
        ? call.function.arguments
        : JSON.stringify(call.function.arguments ?? {})
    }
  }))
  return {
    role: 'assistant',
    content: message.content ?? null,
    tool_calls: toolCalls.length ? toolCalls : undefined
  }
}
