// HTTP requests to research sources and MCP servers, rate limited per host
import { createRateLimiter } from './ratelimit.ts'

// Optional contact info, recommended by Wikimedia, OpenAlex and Crossref
export const CONTACT = process.env.AGENT_CONTACT
export const USER_AGENT = `harness/0.0.0${CONTACT ? ` (${CONTACT})` : ''}`

// Shared by all requests. Set onWarning to hear about budgets running low.
export const rateLimiter = createRateLimiter({
  intervals: {
    // arXiv asks for at most one request every 3 seconds
    'export.arxiv.org': 3000,
    // Keyless Semantic Scholar requests share one pool with everyone
    'api.semanticscholar.org': 1000
  }
})

// Bot protection like Cloudflare's answers with a challenge page instead of content
export const isBotChallenge = (res: Response): boolean =>
  res.headers.get('cf-mitigated') === 'challenge'

export type RequestOptions = {
  method?: 'GET' | 'POST' | 'DELETE'
  body?: URLSearchParams | string
  headers?: Record<string, string>
  timeout?: number
  // Minimum milliseconds between requests to this host
  minInterval?: number
  // Appended to errors, to point the model somewhere else
  hint?: string
  // Return error responses instead of throwing
  allowErrors?: boolean
}

export async function request (url: string, { method = 'GET', body, headers = {}, timeout = 30_000, minInterval, hint = 'Try another source instead.', allowErrors = false }: RequestOptions = {}): Promise<Response> {
  const { hostname } = new URL(url)
  try {
    await rateLimiter.schedule(hostname, minInterval)
    let res: Response
    try {
      res = await fetch(url, { method, body, headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeout) })
    } catch (err) {
      rateLimiter.failed(hostname)
      throw err
    }
    rateLimiter.update(hostname, res)
    if (isBotChallenge(res)) {
      // The site doesn't want automated visits. Respect that, don't work around it.
      rateLimiter.failed(hostname)
      throw new Error(`${hostname} blocks automated clients with a bot challenge`)
    }
    if (!res.ok && !allowErrors) throw new Error(`${hostname} responded ${res.status}${res.statusText ? ` ${res.statusText}` : ''}`)
    return res
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`${message.includes(hostname) ? message : `${hostname} unavailable: ${message}`}. ${hint}`)
  }
}

export const getJson = async (url: string): Promise<any> => (await request(url)).json()
