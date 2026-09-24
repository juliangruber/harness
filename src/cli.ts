#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { cwd, env, exit, stderr, stdin, stdout } from 'node:process'
import { parseArgs, styleText } from 'node:util'
import { runAgent, systemPrompt } from './agent.ts'
import { withBashReview } from './bashreview.ts'
import { answerSeparator, withDebug } from './debug.ts'
import { createDocsTool } from './docs.ts'
import { createGithubTool } from './github.ts'
import { resolveInstructions } from './instructions.ts'
import { createClient, type ToolCall, type Message } from './llm.ts'
import type { McpServer } from './mcp-servers.ts'
import { renderMarkdown } from './markdown.ts'
import { rateLimiter } from './http.ts'
import { createResearchTool } from './research.ts'
import { appendSearches, appendSources, extractSearches, extractUrls, SECTION_HEADING } from './subagent.ts'
import { bash, createToolSearch, restrictFileTools, tools } from './tools.ts'

const { values, positionals } = parseArgs({
  options: {
    debug: { type: 'boolean', short: 'd' },
    trust: { type: 'boolean' },
    // For running in a container: bash commands aren't checked
    unsafe: { type: 'boolean' }
  },
  allowPositionals: true
})

const warn = (text: string) => stderr.write(`${styleText('yellow', text, { stream: stderr })}\n`)
if (values.unsafe) warn('WARNING: --unsafe: bash commands run without checks, and file tools can access files outside the working directory. Only use this in a container.')
else restrictFileTools(cwd())
rateLimiter.onWarning = warn

async function askUser (question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stderr })
  rl.on('SIGINT', () => exit(130))
  try {
    return await rl.question(question)
  } finally {
    rl.close()
  }
}

const instructions = await resolveInstructions(cwd(), {
  trust: values.trust ?? false,
  ask: stdin.isTTY ? askUser : undefined,
  warn
})

const baseUrl = env.AGENT_BASE_URL ?? 'http://localhost:11434/v1'
const model = env.AGENT_MODEL ?? 'qwen3.8'
const onRetry = (err: Error) => warn(`${err.message}, retrying`)
const llm = createClient({ baseUrl, model, apiKey: env.AGENT_API_KEY, onRetry })
const researchLlm = createClient({ baseUrl, model: env.AGENT_RESEARCH_MODEL ?? model, apiKey: env.AGENT_API_KEY, onRetry })

// Tools the model asked for, collected per question and printed after the answer
const toolRequests = new Set<string>()
const toolSearch = createToolSearch(description => toolRequests.add(description))
const logToolCall = (prefix: string) => (call: ToolCall) => {
  // Debug mode already logs tool calls
  if (!values.debug) stderr.write(`[${prefix}${call.function.name}] ${call.function.arguments}\n`)
}
// Models sometimes call tools by made up names. Close to an existing tool's
// name it's a naming problem, otherwise it's a request for a new tool.
const onMissingTool = (call: ToolCall, suggestions: string[]) => {
  if (suggestions.length) warn(`WARNING: unknown tool ${call.function.name}, probably meant ${suggestions.join(' or ')}`)
  else toolRequests.add(`${call.function.name} ${call.function.arguments}`)
}

const subagentOptions = (label: string) => ({
  client: values.debug ? withDebug(researchLlm, { label }) : researchLlm,
  extraTools: [toolSearch],
  onToolCall: logToolCall(`${label} > `),
  onMissingTool
})
const onMcpError = (server: McpServer, err: Error) => warn(`MCP server ${server.name} unavailable: ${err.message}`)
const research = createResearchTool(subagentOptions('research'))
const docs = createDocsTool({ ...subagentOptions('docs'), onError: onMcpError })
const github = createGithubTool()
// Their answers carry sources and suggested web searches
const subagents = new Set([research.name, docs.name])

// bash only runs when the other tools can't do the same and the command is
// safe, unless --unsafe skips the check
const checkedBash = values.unsafe
  ? bash
  : withBashReview(bash, {
    client: values.debug ? withDebug(llm, { label: 'bash review' }) : llm,
    tools: [...tools.filter(tool => tool !== bash), github, research, docs],
    onReview: (_, review) => warn(
      !review.safe
        ? `WARNING: bash refused as unsafe: ${review.safety}`
        : review.useTools
          ? `WARNING: bash refused, use ${review.tools.join(' or ') || 'the other tools'}: ${review.reason}`
          : `WARNING: bash used: ${review.reason}`
    )
  })
const mainTools = [...tools.map(tool => tool === bash ? checkedBash : tool), github, research, docs, toolSearch]

const client = values.debug ? withDebug(llm) : llm
const messages: Message[] = [{ role: 'system', content: systemPrompt(cwd(), instructions, { bashReview: !values.unsafe, restrictFiles: !values.unsafe }) }]

async function ask (prompt: string) {
  messages.push({ role: 'user', content: prompt })
  toolRequests.clear()
  const researchUrls: string[] = []
  const researchSearches: string[] = []
  let answer = await runAgent(messages, {
    client,
    tools: mainTools,
    onToolCall: logToolCall(''),
    onToolResult: (call, result) => {
      if (!subagents.has(call.function.name)) return
      researchUrls.push(...extractUrls(result))
      researchSearches.push(...extractSearches(result))
    },
    onMissingTool
  })
  answer = appendSources(answer, [...new Set(researchUrls)])
  answer = appendSearches(answer, [...new Set(researchSearches)])
  // Keep the conversation in sync with what the user sees
  const last = messages.at(-1)
  if (last?.role === 'assistant') last.content = answer
  if (values.debug) stderr.write(answerSeparator())
  stdout.write(`${renderMarkdown(answer, { highlight: SECTION_HEADING })}\n`)
  for (const request of toolRequests) {
    stderr.write(`${styleText('red', `TODO: add tool: ${request}`, { stream: stderr })}\n`)
  }
}

const prompt = positionals.join(' ')

if (prompt) {
  await ask(prompt)
} else {
  // Write the prompt manually: rl.prompt() throws once stdin has ended
  const rl = createInterface({ input: stdin })
  stdout.write('> ')
  for await (const line of rl) {
    if (line.trim()) {
      try {
        await ask(line)
      } catch (err) {
        stderr.write(`${err instanceof Error ? err.message : err}\n`)
      }
    }
    stdout.write('> ')
  }
}
