import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AssistantMessage, ChatClient, Message, ToolSchema } from '../src/llm.ts'
import type { McpClient } from '../src/mcp.ts'
import { createResearchTool, researchPrompt } from '../src/research.ts'
import { appendSearches, appendSources, extractSearches, extractUrls } from '../src/subagent.ts'
import { mockFetch } from './helpers.ts'

test('research runs a separate agent with the source tools', async t => {
  mockFetch(t, {
    'en.wikipedia.org': () => ({ query: { search: [{ title: 'Love', snippet: 'a feeling' }] } })
  })
  const replies: AssistantMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wikipedia_search', arguments: '{"query":"love"}' } }] },
    { role: 'assistant', content: 'Love is a feeling.\n\nSources:\n- https://en.wikipedia.org/wiki/Love' }
  ]
  const calls: { messages: Message[], tools: ToolSchema[] }[] = []
  const client: ChatClient = {
    async chat (messages, tools) {
      calls.push({ messages: structuredClone(messages), tools })
      return replies.shift()!
    }
  }
  const toolCalls: string[] = []
  const research = createResearchTool({ client, onToolCall: call => toolCalls.push(call.function.name) })

  const answer = await research.run({ question: 'What is love?' })

  assert.match(answer, /Sources:\n- https:\/\/en\.wikipedia\.org\/wiki\/Love/)
  assert.deepEqual(toolCalls, ['wikipedia_search'])
  const [first, second] = calls
  assert.match(first.messages[0].content!, /research agent\. Today's date is \d{4}-\d{2}-\d{2}/)
  assert.match(first.messages[0].content!, /only return abstracts, not full papers, so say when a claim is based on an abstract/)
  assert.equal(first.messages[1].content, 'What is love?')
  assert.deepEqual(first.tools.map(tool => tool.function.name), [
    'wikipedia_search', 'wikipedia_article', 'wikidata_search', 'wikidata_entity',
    'search_papers', 'search_openalex', 'search_semantic_scholar', 'search_crossref', 'search_europe_pmc', 'search_arxiv',
    'wolfram_alpha'
  ])
  assert.match(second.messages.at(-1)!.content!, /https:\/\/en\.wikipedia\.org\/wiki\/Love/)
})

test('research only contacts Wolfram when wolfram_alpha is called', async () => {
  const connected: string[] = []
  const called: string[] = []
  const wolfram: McpClient = {
    serverInfo: { name: 'Wolfram' },
    listTools: async () => [],
    callTool: async (name, args) => { called.push(`${name} ${JSON.stringify(args)}`); return 'x^3/3 https://www.wolframalpha.com/input?i=integrate+x%5E2' },
    close: async () => {}
  }
  const connect = async (url: string) => { connected.push(url); return wolfram }

  // A question that isn't maths: the model doesn't call wolfram_alpha
  const schemas: ToolSchema[][] = []
  const noMaths: ChatClient = {
    async chat (messages, tools) {
      schemas.push(tools)
      return { role: 'assistant', content: 'Love is a feeling. https://en.wikipedia.org/wiki/Love' }
    }
  }
  await createResearchTool({ client: noMaths, connect }).run({ question: 'What is love?' })
  assert.equal(schemas[0].at(-1)!.function.name, 'wolfram_alpha')
  assert.match(schemas[0].at(-1)!.function.description, /Only use it for maths/)
  assert.deepEqual(connected, [])

  // A maths question: the model calls it, and only then Wolfram is contacted
  const replies: AssistantMessage[] = [
    { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'wolfram_alpha', arguments: '{"query":"integrate x^2"}' } }] },
    { role: 'assistant', content: 'x³/3. https://www.wolframalpha.com/input?i=integrate+x%5E2' }
  ]
  const maths: ChatClient = { chat: async () => replies.shift()! }
  await createResearchTool({ client: maths, connect }).run({ question: 'What is the integral of x^2?' })
  assert.deepEqual(connected, ['https://agenttools.wolfram.com/mcp'])
  assert.deepEqual(called, ['WolframAlpha {"query":"integrate x^2"}'])
})

test('research prompt limits wolfram_alpha to maths', () => {
  assert.match(researchPrompt(), /Only use wolfram_alpha when the question is about mathematics/)
})

test('research asks for sources when the answer has none', async () => {
  const replies: AssistantMessage[] = [
    { role: 'assistant', content: 'Love is a feeling.' },
    { role: 'assistant', content: '- https://en.wikipedia.org/wiki/Love' }
  ]
  const calls: Message[][] = []
  const client: ChatClient = {
    async chat (messages) {
      calls.push(structuredClone(messages))
      return replies.shift()!
    }
  }

  const answer = await createResearchTool({ client }).run({ question: 'What is love?' })

  assert.equal(answer, 'Love is a feeling.\n\n- https://en.wikipedia.org/wiki/Love')
  assert.equal(calls[1].at(-1)!.content, 'List the URL of every source you used.')
})

test('extractUrls finds unique urls without trailing punctuation', () => {
  assert.deepEqual(
    extractUrls('See https://a.org/x. Also (https://b.org/y), https://en.wikipedia.org/wiki/Mercury_(planet) and https://a.org/x'),
    ['https://a.org/x', 'https://b.org/y', 'https://en.wikipedia.org/wiki/Mercury_(planet)']
  )
})

test('research prompt asks for suggested web searches', async () => {
  const calls: Message[][] = []
  const client: ChatClient = {
    async chat (messages) {
      calls.push(structuredClone(messages))
      return { role: 'assistant', content: 'A feeling. https://en.wikipedia.org/wiki/Love' }
    }
  }

  await createResearchTool({ client }).run({ question: 'What is love?' })

  assert.match(calls[0][0].content!, /end with a "Suggested web searches:" list of search queries/)
})

test('extractSearches reads the suggested web searches list', () => {
  assert.deepEqual(extractSearches('Answer.\n\nSources:\n- https://a.org'), [])
  assert.deepEqual(extractSearches('Answer.\n\nSuggested web searches:\n- love psychology\n- "love languages"\n\nThanks'), ['love psychology', 'love languages'])
  assert.deepEqual(extractSearches('**Suggested web searches**\n\n1. first query\n2) second query\nNot a query'), ['first query', 'second query'])
  assert.deepEqual(extractSearches('### Suggested Web Searches:\n* one\n* one'), ['one'])
  assert.deepEqual(extractSearches('Suggested web searches for truly current news:\n\n- "JWST news 2026"'), ['JWST news 2026'])
  assert.deepEqual(extractSearches('I suggested web searches: see below\n- nope'), [])
})

test('appendSearches adds only missing searches', () => {
  assert.equal(appendSearches('Done.', []), 'Done.')
  assert.equal(appendSearches('Try: Love Psychology', ['love psychology']), 'Try: Love Psychology')
  assert.equal(appendSearches('Done.', ['love psychology']), 'Done.\n\nSuggested web searches:\n- love psychology')
  assert.equal(appendSearches('Try love psychology', ['love psychology', 'love news']), 'Try love psychology\n\nMore suggested web searches:\n- love news')
})

test('appendSources adds only missing urls', () => {
  assert.equal(appendSources('Done.', []), 'Done.')
  assert.equal(appendSources('See https://a.org', ['https://a.org']), 'See https://a.org')
  assert.equal(appendSources('Done.', ['https://a.org']), 'Done.\n\nSources:\n- https://a.org')
  assert.equal(appendSources('See https://a.org', ['https://a.org', 'https://b.org']), 'See https://a.org\n\nMore sources:\n- https://b.org')
})
