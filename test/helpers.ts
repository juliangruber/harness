import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { TestContext } from 'node:test'

// Replaces fetch with handlers by hostname, restored after the test.
// Responses are sent as is, strings as text, numbers as an error status and
// anything else as JSON.
export function mockFetch (t: TestContext, routes: Record<string, (url: URL, init?: RequestInit) => unknown>) {
  const requests: URL[] = []
  t.mock.method(globalThis, 'fetch', async (input: string, init?: RequestInit) => {
    const url = new URL(input)
    requests.push(url)
    const body = routes[url.hostname]?.(url, init) ?? 404
    if (body instanceof Response) return body
    if (typeof body === 'number') return new Response('error', { status: body, statusText: 'Error' })
    return typeof body === 'string' ? new Response(body) : Response.json(body)
  })
  return requests
}

export type RecordedRequest = { url?: string, headers: Record<string, unknown>, body: any }

// Fake /v1/chat/completions server that answers with the given assistant
// messages, in order. A reply like { status: 500 } is sent as an error.
export async function fakeServer (replies: object[]) {
  const requests: RecordedRequest[] = []
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    requests.push({ url: req.url, headers: req.headers, body: JSON.parse(body) })
    const message = replies.shift()
    if (!message) {
      res.statusCode = 500
      res.end('no more replies')
      return
    }
    if ('status' in message && typeof message.status === 'number') {
      res.statusCode = message.status
      res.end('fake error')
      return
    }
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify({ choices: [{ index: 0, message }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => server.close()
  }
}
