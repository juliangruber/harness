import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRateLimiter } from '../src/ratelimit.ts'

// A clock that only moves when sleeping or told to
function fakeClock () {
  let time = 1_000_000_000_000
  const sleeps: number[] = []
  return {
    now: () => time,
    sleep: async (ms: number) => { sleeps.push(ms); time += ms },
    advance: (ms: number) => { time += ms },
    sleeps
  }
}

const response = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers })

test('spaces requests by the configured interval', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter({ intervals: { 'a.org': 3000 }, ...clock })

  await limiter.schedule('a.org')
  await limiter.schedule('a.org')
  await limiter.schedule('b.org')

  assert.deepEqual(clock.sleeps, [3000])
})

test('schedule can raise the spacing for a host', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)

  await limiter.schedule('site.example', 1000)
  await limiter.schedule('site.example', 1000)

  assert.deepEqual(clock.sleeps, [1000])
})

test('backs off for Retry-After seconds, and 60s without it', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)

  limiter.update('a.org', response(429, { 'retry-after': '120' }))
  await assert.rejects(limiter.schedule('a.org'), /^Error: a\.org is rate limiting, skipping it for 120s$/)
  clock.advance(120_000)
  await limiter.schedule('a.org')

  for (const status of [502, 503, 504]) {
    limiter.update(`${status}.org`, response(status))
    await assert.rejects(limiter.schedule(`${status}.org`), /skipping it for 60s/)
  }
  limiter.update('ok.org', response(500))
  await limiter.schedule('ok.org')
})

test('backs off after timeouts and network errors', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)

  limiter.failed('a.org')

  await assert.rejects(limiter.schedule('a.org'), /skipping it for 60s/)
})

test('backs off until a Retry-After date', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)

  limiter.update('a.org', response(429, { 'retry-after': new Date(clock.now() + 30_000).toUTCString() }))

  await assert.rejects(limiter.schedule('a.org'), /skipping it for 30s/)
})

test('blocks when a budget is used up, and warns once when it runs low', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)
  const warnings: string[] = []
  limiter.onWarning = text => warnings.push(text)

  limiter.update('api.openalex.org', response(200, { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '760', 'x-ratelimit-reset': '41367' }))
  limiter.update('api.openalex.org', response(200, { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '90', 'x-ratelimit-reset': '41000' }))
  limiter.update('api.openalex.org', response(200, { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '80', 'x-ratelimit-reset': '40000' }))
  await limiter.schedule('api.openalex.org')
  assert.deepEqual(warnings, ['api.openalex.org: rate limit almost used up, 90 of 1000 left, resets in 12h'])

  limiter.update('api.openalex.org', response(200, { 'x-ratelimit-limit': '1000', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '3600' }))
  await assert.rejects(limiter.schedule('api.openalex.org'), /skipping it for 60m/)
})

test('spaces requests by x-rate-limit headers', async () => {
  const clock = fakeClock()
  const limiter = createRateLimiter(clock)

  limiter.update('api.crossref.org', response(200, { 'x-rate-limit-limit': '1', 'x-rate-limit-interval': '1s' }))
  await limiter.schedule('api.crossref.org')
  await limiter.schedule('api.crossref.org')

  assert.deepEqual(clock.sleeps, [1000])
})
