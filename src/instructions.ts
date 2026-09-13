import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stripControl } from './markdown.ts'

export type Instructions = { path: string, content: string }

// In order of preference, matched case insensitively
const FILENAMES = ['agents.md', 'agent.md', 'claude.md']
const PREVIEW_LINES = 10

export async function findInstructions (cwd: string): Promise<Instructions | undefined> {
  const entries = await readdir(cwd, { withFileTypes: true })
  for (const filename of FILENAMES) {
    const entry = entries.find(e => e.isFile() && e.name.toLowerCase() === filename)
    if (entry) {
      const path = join(cwd, entry.name)
      return { path, content: await readFile(path, 'utf8') }
    }
  }
}

export type ResolveOptions = {
  // Load without asking
  trust: boolean
  // Asks the user a question, undefined when there is nobody to ask
  ask?: (question: string) => Promise<string>
  warn: (text: string) => void
}

// Instructions are only used if the user trusts them, every time
export async function resolveInstructions (cwd: string, { trust, ask, warn }: ResolveOptions): Promise<Instructions | undefined> {
  const instructions = await findInstructions(cwd)
  if (!instructions || trust) return instructions

  if (!ask) {
    warn(`Ignoring ${instructions.path}: can't ask whether to trust it. Pass --trust to use it.`)
    return
  }

  // Strip control characters, so hidden or line-rewriting text can't disguise
  // what the file actually says in the preview the user approves
  const lines = stripControl(instructions.content).split('\n')
  const preview = lines.slice(0, PREVIEW_LINES).map(line => `  ${line}`).join('\n')
  const more = lines.length > PREVIEW_LINES ? `\n  [${lines.length - PREVIEW_LINES} more lines]` : ''
  const answer = await ask(`Found ${instructions.path} for review:\n${preview}${more}\nUse these instructions? [y/N] `)
  if (/^y(es)?$/i.test(answer.trim())) return instructions
}
