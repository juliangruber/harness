// Per host rate limiting that follows what APIs tell us: Retry-After on 429
// and 503, budget headers (x-ratelimit-*) and rate headers (x-rate-limit-*)
import { setTimeout } from 'node:timers/promises'

const DEFAULT_COOLDOWN = 60_000
// Warn when this share of a budget is left
const LOW_REMAINING = 0.1

export type RateLimiterOptions = {
  // Minimum milliseconds between requests, for hosts with documented limits but no headers
  intervals?: Record<string, number>
  now?: () => number
  sleep?: (ms: number) => Promise<unknown>
}

export type RateLimiter = {
  // Throws while the host asked us to back off, otherwise waits for our turn.
  // minInterval raises the spacing between requests to this host.
  schedule (host: string, minInterval?: number): Promise<void>
  // Learns limits from a response
  update (host: string, res: Response): void
  // Timeouts and network errors: give the host a break too
  failed (host: string): void
  onWarning?: (text: string) => void
}

type HostState = {
  interval: number
  nextRequest: number
  blockedUntil: number
  warned: boolean
}

export function createRateLimiter ({ intervals = {}, now = Date.now, sleep = setTimeout }: RateLimiterOptions = {}): RateLimiter {
  const hosts = new Map<string, HostState>()

  const state = (host: string): HostState => {
    let hostState = hosts.get(host)
    if (!hostState) {
      hostState = { interval: intervals[host] ?? 0, nextRequest: 0, blockedUntil: 0, warned: false }
      hosts.set(host, hostState)
    }
    return hostState
  }

  const limiter: RateLimiter = {
    async schedule (host, minInterval = 0) {
      const hostState = state(host)
      hostState.interval = Math.max(hostState.interval, minInterval)
      const blocked = hostState.blockedUntil - now()
      if (blocked > 0) throw new Error(`${host} is rate limiting, skipping it for ${formatDuration(blocked)}`)

      const wait = hostState.nextRequest - now()
      hostState.nextRequest = Math.max(now(), hostState.nextRequest) + hostState.interval
      if (wait > 0) await sleep(wait)
    },

    failed (host) {
      const hostState = state(host)
      hostState.blockedUntil = Math.max(hostState.blockedUntil, now() + DEFAULT_COOLDOWN)
    },

    update (host, res) {
      const hostState = state(host)
      const header = (name: string) => res.headers.get(name)
      const block = (until: number) => { hostState.blockedUntil = Math.max(hostState.blockedUntil, until) }

      // Overloaded: too many requests, or the server (or a gateway in front of it) gave up
      if ([429, 502, 503, 504].includes(res.status)) {
        block(now() + (parseRetryAfter(header('retry-after'), now()) ?? DEFAULT_COOLDOWN))
      }

      // Budgets, like OpenAlex's daily credits
      const limit = Number(header('x-ratelimit-limit'))
      const remaining = header('x-ratelimit-remaining') === null ? NaN : Number(header('x-ratelimit-remaining'))
      const reset = parseReset(header('x-ratelimit-reset'), now())
      if (remaining <= 0 && reset !== undefined) block(reset)
      if (limit > 0 && remaining <= limit * LOW_REMAINING) {
        if (!hostState.warned) {
          hostState.warned = true
          limiter.onWarning?.(`${host}: rate limit almost used up, ${remaining} of ${limit} left${reset === undefined ? '' : `, resets in ${formatDuration(reset - now())}`}`)
        }
      } else if (remaining > limit * LOW_REMAINING) {
        hostState.warned = false
      }

      // Rates, like Crossref's "1 request per 1s"
      const rateLimit = Number(header('x-rate-limit-limit'))
      const interval = parseDuration(header('x-rate-limit-interval'))
      if (rateLimit > 0 && interval !== undefined) {
        hostState.interval = Math.max(intervals[host] ?? 0, interval / rateLimit)
      }
    }
  }
  return limiter
}

// Retry-After is either seconds or an HTTP date
function parseRetryAfter (value: string | null, now: number): number | undefined {
  if (value === null) return
  if (/^\d+$/.test(value.trim())) return Number(value) * 1000
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - now)
}

// Resets are either seconds from now or a unix timestamp
function parseReset (value: string | null, now: number): number | undefined {
  if (value === null) return
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return
  return seconds > 1e9 ? seconds * 1000 : now + seconds * 1000
}

function parseDuration (value: string | null): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/)
  if (!match) return
  const units: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }
  return Number(match[1]) * units[match[2] ?? 's']
}

function formatDuration (ms: number): string {
  const seconds = Math.ceil(ms / 1000)
  if (seconds < 600) return `${seconds}s`
  if (seconds < 7200) return `${Math.ceil(seconds / 60)}m`
  return `${Math.ceil(seconds / 3600)}h`
}
