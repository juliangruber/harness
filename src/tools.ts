import { execFile } from 'node:child_process'
import { glob as fsGlob, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export type Tool = {
  name: string
  description: string
  parameters: object
  run (args: any): Promise<string>
}

const MAX_OUTPUT = 30_000
const MAX_RESULTS = 200
// Longest line grep runs a pattern against, to bound regex backtracking
const MAX_LINE = 1000

const truncate = (text: string): string =>
  text.length > MAX_OUTPUT
    ? `${text.slice(0, MAX_OUTPUT)}\n[truncated ${text.length - MAX_OUTPUT} chars]`
    : text

const limitResults = (results: string[]): string =>
  truncate(results.length > MAX_RESULTS
    ? [...results.slice(0, MAX_RESULTS), `[${results.length - MAX_RESULTS} more results]`].join('\n')
    : results.join('\n'))

const IGNORED = /(^|\/)(node_modules|\.git)$/

const walk = async (pattern: string, cwd: string): Promise<string[]> =>
  (await Array.fromAsync(fsGlob(pattern, { cwd, exclude: path => IGNORED.test(path) }))).sort()

// File tools only access files inside this directory. Undefined lifts the limit.
let fileRoot: string | undefined

export function restrictFileTools (directory: string | undefined): void {
  fileRoot = directory === undefined ? undefined : resolve(directory)
}

// Follows symlinks. A path that doesn't exist yet resolves through its nearest
// existing parent, so a new file can't be written through a link either.
async function realPathOf (path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err
    const parent = dirname(path)
    return parent === path ? path : join(await realPathOf(parent), basename(path))
  }
}

async function isAllowed (path: string): Promise<boolean> {
  if (fileRoot === undefined) return true
  const rel = relative(await realPathOf(fileRoot), await realPathOf(resolve(path)))
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

async function checkPath (path: string): Promise<void> {
  if (!await isAllowed(path)) {
    throw new Error(`${path} is outside the working directory ${fileRoot}, file tools can only access files inside it`)
  }
}

// Writing into .git would let a planted hook run on the next git command,
// outside the harness. Refused even inside the working directory.
async function checkWritePath (path: string): Promise<void> {
  await checkPath(path)
  if (fileRoot === undefined) return
  const real = await realPathOf(resolve(path))
  if (real.split(sep).includes('.git')) {
    throw new Error(`${path} is inside a .git directory, which file tools don't write to`)
  }
}

export const read: Tool = {
  name: 'read',
  description: 'Read a text file. For large files, use offset and limit to read a range of lines.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      offset: { type: 'number', description: 'First line to read, starting at 1' },
      limit: { type: 'number', description: 'Maximum number of lines to read' }
    },
    required: ['path']
  },
  async run ({ path, offset = 1, limit }: { path: string, offset?: number, limit?: number }) {
    await checkPath(path)
    const lines = (await readFile(path, 'utf8')).split('\n')
    const end = limit === undefined ? lines.length : offset - 1 + limit
    let output = lines.slice(offset - 1, end).join('\n')
    if (end < lines.length) output += `\n[${lines.length - end} more lines, continue with offset ${end + 1}]`
    return truncate(output)
  }
}

export const write: Tool = {
  name: 'write',
  description: 'Write content to a file, creating parent directories and overwriting existing content.',
  parameters: {
    type: 'object',
    properties: { path: { type: 'string' }, content: { type: 'string' } },
    required: ['path', 'content']
  },
  async run ({ path, content }: { path: string, content: string }) {
    await checkWritePath(path)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content)
    return `Wrote ${content.length} chars to ${path}`
  }
}

export const edit: Tool = {
  name: 'edit',
  description: 'Replace an exact string in a file. old_string must match exactly once, unless replace_all is set.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      old_string: { type: 'string', description: 'Exact text to replace, including whitespace' },
      new_string: { type: 'string' },
      replace_all: { type: 'boolean', description: 'Replace every occurrence' }
    },
    required: ['path', 'old_string', 'new_string']
  },
  async run ({ path, old_string: oldString, new_string: newString, replace_all: replaceAll = false }: { path: string, old_string: string, new_string: string, replace_all?: boolean }) {
    if (!oldString) throw new Error('old_string must not be empty')
    await checkWritePath(path)
    const parts = (await readFile(path, 'utf8')).split(oldString)
    const count = parts.length - 1
    if (count === 0) throw new Error(`old_string not found in ${path}`)
    if (count > 1 && !replaceAll) {
      throw new Error(`old_string found ${count} times in ${path}. Include more surrounding text to make it unique, or set replace_all`)
    }
    // split/join instead of String.replace, so `$&` and friends stay literal
    await writeFile(path, parts.join(newString))
    return `Replaced ${count} occurrence${count === 1 ? '' : 's'} in ${path}`
  }
}

const IGNORED_NAMES = new Set(['node_modules', '.git'])

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`

export const glob: Tool = {
  name: 'glob',
  description: 'List files and directories matching a glob pattern, like "*" for the directory, "src/**/*.ts" or "{*.md,*/*.md}". Hidden files are included. Directories end with "/", files show their size. Doesn\'t look inside node_modules and .git. Use it instead of find, and ls to list a single directory.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern, defaults to "*": everything in the directory' },
      path: { type: 'string', description: 'Directory to search in, defaults to the working directory' }
    }
  },
  async run ({ pattern = '*', path = '.' }: { pattern?: string, path?: string }) {
    await checkPath(path)
    // Globs skip hidden files, so also match the last part with a leading dot:
    // "*" becomes ".*", "**/*.md" becomes "**/.*.md"
    const segments = pattern.split('/')
    const last = segments.pop()!
    const patterns = last.startsWith('.') ? [pattern] : [pattern, [...segments, `.${last}`].join('/')]

    const entries = new Map<string, { path: string, fullPath: string, directory: boolean }>()
    for (const variant of patterns) {
      // node_modules and .git are listed, but never searched inside
      for await (const entry of fsGlob(variant, { cwd: path, withFileTypes: true, exclude: dirent => IGNORED_NAMES.has(dirent.name) })) {
        const fullPath = join(entry.parentPath, entry.name)
        const relativePath = relative(path, fullPath)
        // Patterns like "../*" and symlinks can reach outside the working directory
        if (relativePath && await isAllowed(fullPath)) entries.set(fullPath, { path: join(path, relativePath), fullPath, directory: entry.isDirectory() })
      }
    }
    if (!entries.size) return 'No files found'

    const sorted = [...entries.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    const lines = await Promise.all(sorted.slice(0, MAX_RESULTS).map(async entry => {
      if (entry.directory) return `${entry.path}/`
      try {
        return `${entry.path} (${formatSize((await stat(entry.fullPath)).size)})`
      } catch {
        return entry.path
      }
    }))
    if (sorted.length > MAX_RESULTS) lines.push(`[${sorted.length - MAX_RESULTS} more results]`)
    return truncate(lines.join('\n'))
  }
}

// Models reach for ls out of habit, so listing a directory gets its own name
export const ls: Tool = {
  name: 'ls',
  description: 'List a directory, like ls -la: hidden files included, directories end with "/", files show their size. Use it instead of running ls in bash.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory to list, defaults to the working directory' }
    }
  },
  run: ({ path = '.' }: { path?: string }) => glob.run({ pattern: '*', path })
}

export const grep: Tool = {
  name: 'grep',
  description: 'Search file contents with a JavaScript regular expression. Returns file:line: text. Skips node_modules, .git and binary files.',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regular expression' },
      path: { type: 'string', description: 'File or directory to search in, defaults to the working directory' },
      include: { type: 'string', description: 'Glob of files to search, like "**/*.ts"' }
    },
    required: ['pattern']
  },
  async run ({ pattern, path = '.', include = '**/*' }: { pattern: string, path?: string, include?: string }) {
    const regex = new RegExp(pattern)
    await checkPath(path)
    // Cap the input each match sees, so a catastrophic-backtracking pattern
    // can't hang on a very long line (a minified file, say)
    const forMatch = (line: string) => line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line
    const files = (await stat(path)).isFile()
      ? [path]
      : (await walk(include, path)).map(file => join(path, file))
    const matches: string[] = []

    for (const file of files) {
      if (!await isAllowed(file)) continue
      let content: string
      try {
        content = await readFile(file, 'utf8')
      } catch {
        continue // directories, unreadable files
      }
      if (content.includes('\0')) continue
      content.split('\n').forEach((line, i) => {
        if (regex.test(forMatch(line))) matches.push(`${file}:${i + 1}: ${line.slice(0, 500)}`)
      })
      if (matches.length > MAX_RESULTS) break
    }
    return matches.length ? limitResults(matches) : 'No matches found'
  }
}

// Keeps secrets, like the LLM API key, out of commands the model runs
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH/i

const scrubbedEnv = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !SECRET_ENV.test(name)))

export const bash: Tool = {
  name: 'bash',
  description: 'Run a bash command in the working directory. Returns stdout and stderr. Prefer the dedicated tools when one fits.',
  parameters: {
    type: 'object',
    properties: { command: { type: 'string', description: 'The command to run' } },
    required: ['command']
  },
  run ({ command }: { command: string }) {
    return new Promise(resolve => {
      execFile('bash', ['-c', command], { timeout: 120_000, maxBuffer: 10 * 1024 * 1024, env: scrubbedEnv() }, (err, stdout, stderr) => {
        let output = stdout + stderr
        if (err) output += `\n[exit ${err.code ?? err.signal}]`
        resolve(truncate(output))
      })
    })
  }
}

// Tools that are missing on purpose, so the model doesn't keep asking for them.
// Fetching arbitrary pages and web search would send agent traffic to ad funded sites.
export const UNAVAILABLE_TOOLS = ['fetch web page', 'search the web']

// Finds nothing, on purpose: requests show which tools are worth adding
export function createToolSearch (onSearch: (description: string) => void): Tool {
  return {
    name: 'tool_search',
    description: `Search for more tools by describing what you need a tool to do. Use it when none of your tools fit. Known to be unavailable, don't search for: ${UNAVAILABLE_TOOLS.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the tool should do, like "fetch a web page as text"' }
      },
      required: ['description']
    },
    async run ({ description }: { description: string }) {
      onSearch(description)
      return 'No matching tools found. Continue with the tools you have.'
    }
  }
}

export const tools: Tool[] = [read, write, edit, ls, glob, grep, bash]
