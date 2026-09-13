import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createClient } from '../src/llm.ts'
import { fakeServer } from './helpers.ts'

const schema = { type: 'function' as const, function: { name: 'bash', description: '', parameters: {} } }

test('posts model, messages and tools to /chat/completions', async t => {
  const server = await fakeServer([{ role: 'assistant', content: 'hi' }])
  t.after(server.close)
  const client = createClient({ baseUrl: server.baseUrl, model: 'm', apiKey: 'secret' })

  const reply = await client.chat([{ role: 'user', content: 'hello' }], [schema])

  assert.deepEqual(reply, { role: 'assistant', content: 'hi', tool_calls: undefined })
  const [req] = server.requests
  assert.equal(req.url, '/v1/chat/completions')
  assert.equal(req.headers.authorization, 'Bearer secret')
  assert.equal(req.body.model, 'm')
  assert.deepEqual(req.body.messages, [{ role: 'user', content: 'hello' }])
  assert.deepEqual(req.body.tools, [schema])
})

test('normalizes tool calls with object arguments and missing ids', async t => {
  const server = await fakeServer([{
    role: 'assistant',
    content: '',
    reasoning: 'thinking...',
    tool_calls: [{ type: 'function', function: { name: 'bash', arguments: { command: 'ls' } } }]
  }])
  t.after(server.close)
  const client = createClient({ baseUrl: server.baseUrl, model: 'm' })

  const reply = await client.chat([], [])

  assert.equal('reasoning' in reply, false)
  assert.equal(reply.tool_calls?.length, 1)
  assert.match(reply.tool_calls[0].id, /^call_/)
  assert.equal(reply.tool_calls[0].function.arguments, '{"command":"ls"}')
})

test('retries server errors', async t => {
  const server = await fakeServer([{ status: 500 }, { role: 'assistant', content: 'hi' }])
  t.after(server.close)
  const retried: string[] = []
  const client = createClient({ baseUrl: server.baseUrl, model: 'm', onRetry: err => retried.push(err.message) })

  assert.equal((await client.chat([], [])).content, 'hi')
  assert.equal(server.requests.length, 2)
  assert.deepEqual(retried, ['LLM request failed: 500 Internal Server Error fake error'])
})

test('throws on HTTP errors after retries, and on client errors right away', async t => {
  const server = await fakeServer([{ status: 400 }])
  t.after(server.close)
  const client = createClient({ baseUrl: server.baseUrl, model: 'm' })

  await assert.rejects(client.chat([], []), /400/)
  assert.equal(server.requests.length, 1)

  await assert.rejects(client.chat([], []), /500/)
  assert.equal(server.requests.length, 4)
})
