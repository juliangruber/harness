import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent } from '../src/agent.ts'
import { withDebug } from '../src/debug.ts'
import type { AssistantMessage, ChatClient, Message } from '../src/llm.ts'
import type { Tool } from '../src/tools.ts'

const echo: Tool = {
  name: 'echo',
  description: 'Echo text',
  parameters: { type: 'object' },
  async run ({ text }) { return `echo: ${text}` }
}

test('logs every message exactly once, including implicit ones', async () => {
  const replies: AssistantMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'echo', arguments: '{"text":"hi"}' } }] },
    { role: 'assistant', content: 'done' }
  ]
  const inner: ChatClient = { chat: async () => replies.shift()! }
  let output = ''
  const client = withDebug(inner, { log: text => { output += text } })
  const messages: Message[] = [
    { role: 'system', content: 'preamble' },
    { role: 'user', content: 'hello' }
  ]

  await runAgent(messages, { client, tools: [echo] })

  assert.equal(output, `--- tools ---
echo: Echo text
--- system ---
preamble
--- user ---
hello
--- assistant ---
echo call_1
  text: hi
--- tool result: echo call_1 ---
echo: hi
--- assistant ---
done
`)
})

test('formats markdown, multi-line arguments and JSON results', async () => {
  const replies: AssistantMessage[] = [
    { role: 'assistant', content: '**Writing**', tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'write', arguments: '{"path":"a.txt","content":"one\\ntwo","force":true}' } }] },
    { role: 'assistant', content: 'done' }
  ]
  const writeTool: Tool = { name: 'write', description: 'Write', parameters: {}, async run () { return '{"ok":true}' } }
  let output = ''
  const client = withDebug({ chat: async () => replies.shift()! }, { label: 'research', log: text => { output += text } })

  await runAgent([], { client, tools: [writeTool] })

  assert.equal(output, `--- research: tools ---
write: Write
--- research: assistant ---
Writing
write call_1
  path: a.txt
  content:
    one
    two
  force: true
--- research: tool result: write call_1 ---
{
  "ok": true
}
--- research: assistant ---
done
`)
})
