import { test } from 'node:test'
import assert from 'node:assert/strict'
import { runAgent, similarTools, systemPrompt } from '../src/agent.ts'
import type { AssistantMessage, ChatClient, Message } from '../src/llm.ts'
import type { Tool } from '../src/tools.ts'

// Client that returns scripted replies and records what it was sent
function scriptedClient (replies: AssistantMessage[]) {
  const calls: Message[][] = []
  const client: ChatClient = {
    async chat (messages) {
      calls.push(structuredClone(messages))
      const reply = replies.shift()
      if (!reply) throw new Error('no more replies')
      return reply
    }
  }
  return { client, calls }
}

const toolCall = (name: string, args: string) => ({
  role: 'assistant' as const,
  content: null,
  tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name, arguments: args } }]
})

const echo: Tool = {
  name: 'echo',
  description: 'Echo text',
  parameters: {},
  async run ({ text }) { return `echo: ${text}` }
}

test('system prompt says bash calls are checked, unless the check is off', () => {
  assert.match(systemPrompt('/work'), /every bash call makes an extra round trip, in which a separate check reviews whether the other tools could do the same and whether the command is safe to run/)
  const unchecked = systemPrompt('/work', undefined, { bashReview: false })
  assert.match(unchecked, /Prefer the dedicated tools over bash\./)
  assert.doesNotMatch(unchecked, /round trip/)
})

test('system prompt says file tools are limited to the working directory, unless lifted', () => {
  assert.match(systemPrompt('/work'), /The working directory is \/work\. File tools only access files inside it\./)
  assert.doesNotMatch(systemPrompt('/work', undefined, { restrictFiles: false }), /File tools only access/)
})

test('system prompt lists tools known to be unavailable', () => {
  assert.match(systemPrompt('/work'), /known to be unavailable, don't search for them: fetch web page, search the web\./)
})

test('returns the answer when there are no tool calls', async () => {
  const { client } = scriptedClient([{ role: 'assistant', content: 'done' }])
  const messages: Message[] = [{ role: 'user', content: 'hi' }]

  assert.equal(await runAgent(messages, { client, tools: [echo] }), 'done')
  assert.equal(messages.length, 2)
})

test('runs tools and sends results back to the model', async () => {
  const { client, calls } = scriptedClient([
    toolCall('echo', '{"text":"hello"}'),
    { role: 'assistant', content: 'done' }
  ])

  const answer = await runAgent([{ role: 'user', content: 'hi' }], { client, tools: [echo] })

  assert.equal(answer, 'done')
  assert.deepEqual(calls[1].at(-1), { role: 'tool', tool_call_id: 'call_1', content: 'echo: hello' })
})

test('reports missing tools and bad arguments to the model', async () => {
  const { client, calls } = scriptedClient([
    toolCall('nope', '{"x":1}'),
    toolCall('echo', 'not json'),
    { role: 'assistant', content: 'done' }
  ])
  const missing: string[] = []

  await runAgent([], { client, tools: [echo], onMissingTool: call => missing.push(call.function.name) })

  assert.deepEqual(missing, ['nope'])
  assert.match((calls[1].at(-1) as { content: string }).content, /unknown tool nope\. Use tool_search/)
  assert.match((calls[2].at(-1) as { content: string }).content, /^Error: .*JSON/)
})

test('suggests existing tools for made up tool names', async () => {
  const tools = ['search_papers', 'wikipedia_search', 'tool_search', 'read'].map(name => ({ ...echo, name }))
  assert.deepEqual(similarTools('search_paper_query', tools), ['search_papers'])
  assert.deepEqual(similarTools('web_search', tools), [])

  const { client, calls } = scriptedClient([toolCall('search_paper_query', '{}'), { role: 'assistant', content: 'done' }])
  const suggested: string[][] = []
  await runAgent([], { client, tools, onMissingTool: (_, suggestions) => suggested.push(suggestions) })

  assert.deepEqual(suggested, [['search_papers']])
  assert.equal((calls[1].at(-1) as { content: string }).content, 'Error: unknown tool search_paper_query. Did you mean: search_papers? Otherwise use tool_search to find more tools.')
})

test('stops after maxTurns', async () => {
  const { client } = scriptedClient([toolCall('echo', '{}'), toolCall('echo', '{}')])

  await assert.rejects(runAgent([], { client, tools: [echo], maxTurns: 2 }), /Stopped after 2 turns/)
})
