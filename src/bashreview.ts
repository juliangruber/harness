// Before bash runs, a separate model call checks the command. It answers two
// questions at once: could the other tools do the same, and is the command
// safe to run? If the tools could, the command is refused so the agent uses
// them, and if not, the reason often points at a tool worth adding. Unsafe
// commands are refused. This is a model's judgment, not a security boundary.
import type { ChatClient } from './llm.ts'
import type { Tool } from './tools.ts'

export type BashReview = {
  useTools: boolean
  // Tools to use instead, only set when useTools is true
  tools: string[]
  reason: string
  safe: boolean
  safety: string
}

export type BashReviewOptions = {
  client: ChatClient
  // The tools the agent could use instead of bash
  tools: Tool[]
  // The working directory commands run in, defaults to process.cwd()
  cwd?: string
  onReview?: (command: string, review: BashReview) => void
}

export const bashReviewPrompt = (tools: Tool[], cwd: string): string =>
  `You check a shell command that an agent wants to run with its bash tool, on the user's computer and without asking the user. The working directory is ${cwd}. Besides bash, the agent has these tools:
${tools.map(tool => `- ${tool.name}: ${tool.description}`).join('\n')}

Answer two questions.
1. Can the purpose of the command be achieved with these tools instead of bash? Listing, finding, reading and searching files can be done with them. Running programs, tests, builds, git or package managers can't.
2. Is the command safe to run? It is unsafe if it could:
- delete or overwrite files outside the working directory, or delete many files inside it
- change system settings, install software system wide, or use sudo
- read or send secrets, like SSH keys, tokens, passwords or environment variables
- send data to the internet, other than downloading the project's dependencies
- push, publish or deploy anything, or rewrite git history
- start processes that keep running in the background
Other commands, like running tests, builds, linters or read-only git commands, are safe.

Reply with JSON only: {"use_tools": true or false, "tools": ["names of the tools to use, if use_tools is true"], "reason": "why the tools can or can't do it", "safe": true or false, "safety": "why the command is safe or unsafe"}`

const text = (value: unknown, fallback: string): string =>
  typeof value === 'string' && value.trim() ? value.trim() : fallback

export async function reviewBashCommand (command: string, { client, tools, cwd = process.cwd() }: Omit<BashReviewOptions, 'onReview'>): Promise<BashReview> {
  let answer: any
  try {
    const reply = await client.chat([
      { role: 'system', content: bashReviewPrompt(tools, cwd) },
      { role: 'user', content: `Command:\n${command}` }
    ], [])
    answer = JSON.parse(reply.content?.match(/\{[\s\S]*\}/)?.[0] ?? '')
  } catch {}

  const names = new Set(tools.map(tool => tool.name))
  const useTools = answer?.use_tools === true
  // Only an explicit yes counts as safe, so a failed check refuses the command
  const safe = answer?.safe === true
  return {
    useTools,
    tools: useTools && Array.isArray(answer.tools)
      ? answer.tools.filter((name: unknown): name is string => typeof name === 'string' && names.has(name))
      : [],
    reason: text(answer?.reason, answer ? 'no reason given' : 'the check couldn\'t decide'),
    safe,
    safety: text(answer?.safety, safe ? 'no reason given' : 'the check couldn\'t verify the command is safe')
  }
}

export function withBashReview (bash: Tool, { onReview, ...options }: BashReviewOptions): Tool {
  return {
    ...bash,
    async run (args: { command: string }) {
      const review = await reviewBashCommand(args.command, options)
      onReview?.(args.command, review)
      // Unsafe comes first, so an unsafe command never points the model at another tool
      if (!review.safe) {
        throw new Error(`bash refused as unsafe: ${review.safety.replace(/\.$/, '')}. Don't retry it. If it's needed, ask the user to run it themselves.`)
      }
      if (review.useTools) {
        const instead = review.tools.length ? review.tools.join(', ') : 'the other tools'
        throw new Error(`bash refused: ${review.reason.replace(/\.$/, '')}. Use ${instead} instead.`)
      }
      return bash.run(args)
    }
  }
}
