// Separate file, so the shared rate limiter starts fresh
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sourceTools } from '../src/sources.ts'
import { mockFetch } from './helpers.ts'

const arxiv = sourceTools.find(tool => tool.name === 'search_arxiv')!

test('arxiv fails with a hint and backs off when rate limited', async t => {
  const requests = mockFetch(t, {
    'export.arxiv.org': () => new Response('Rate exceeded.', { status: 429, headers: { 'retry-after': '120' } })
  })

  await assert.rejects(
    arxiv.run({ query: 'tools' }),
    /^Error: export\.arxiv\.org responded 429\. Use search_openalex or search_semantic_scholar instead/
  )
  await assert.rejects(arxiv.run({ query: 'tools' }), /export\.arxiv\.org is rate limiting, skipping it for 120s\. Use search_openalex/)
  assert.equal(requests.length, 1)
})
