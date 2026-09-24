import { execFile } from 'node:child_process'
import { truncate, type Tool } from './tools.ts'

const API = 'https://api.github.com/'

// gh sends full URLs as they are, with the user's token, so only paths on
// the GitHub API are let through
export function apiPath (endpoint: string, query: Record<string, unknown> = {}): string {
  const url = new URL(endpoint.replace(/^\/+/, ''), API)
  if (url.origin !== new URL(API).origin) throw new Error(`${endpoint} is not a GitHub API path`)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value))
  // Starts with "/", so gh can't take it for a flag
  return `${url.pathname}${url.search}`
}

// File contents come base64 encoded, which the model can't read
function decodeContent (output: string): string {
  try {
    const body = JSON.parse(output)
    if (body?.encoding !== 'base64' || typeof body.content !== 'string') return output
    return JSON.stringify({ ...body, encoding: 'utf8', content: Buffer.from(body.content, 'base64').toString('utf8') }, null, 2)
  } catch {
    return output
  }
}

// Read only: every request is a GET, which doesn't change anything on GitHub.
// Uses the gh CLI and whatever account it's logged in with.
export function createGithubTool ({ command = 'gh' }: { command?: string } = {}): Tool {
  return {
    name: 'github',
    description: 'Read from GitHub with a GET request to its REST API, as the user logged in to the gh CLI, private repositories included. Read only: nothing can be created or changed. Examples: "repos/OWNER/REPO", "repos/OWNER/REPO/issues", "repos/OWNER/REPO/pulls/1/files", "repos/OWNER/REPO/contents/PATH" (file contents are decoded), "search/code" with query {"q": "..."}. Use it instead of running gh or curl in bash.',
    parameters: {
      type: 'object',
      properties: {
        endpoint: { type: 'string', description: 'REST API path, like "repos/OWNER/REPO/issues/1"' },
        query: { type: 'object', description: 'Query parameters, like {"state": "open", "per_page": 20}' },
        jq: { type: 'string', description: 'Optional jq expression to select fields from the response, like ".[] | {number, title}"' }
      },
      required: ['endpoint']
    },
    run ({ endpoint, query, jq }: { endpoint: string, query?: Record<string, unknown>, jq?: string }) {
      const args = ['api', '--method', 'GET']
      if (jq) args.push('--jq', jq)
      args.push('--', apiPath(endpoint, query))
      return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 60_000, maxBuffer: 10 * 1024 * 1024, env: { ...process.env, GH_PROMPT_DISABLED: '1' } }, (err, stdout, stderr) => {
          if ((err as NodeJS.ErrnoException | null)?.code === 'ENOENT') {
            reject(new Error('the gh CLI is not installed, see https://cli.github.com'))
            return
          }
          let output = jq ? stdout : decodeContent(stdout)
          if (err) output += `\n${stderr}[exit ${err.code ?? err.signal}]`
          resolve(truncate(output))
        })
      })
    }
  }
}
