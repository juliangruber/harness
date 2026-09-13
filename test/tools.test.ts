import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { bash, createToolSearch, edit, glob, grep, ls, read, restrictFileTools, write } from '../src/tools.ts'

async function tmp (t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-'))
  t.after(() => rm(dir, { recursive: true }))
  return dir
}

test('tool_search finds nothing but reports the request', async () => {
  const requests: string[] = []
  const toolSearch = createToolSearch(description => requests.push(description))

  assert.equal(await toolSearch.run({ description: 'fetch a web page' }), 'No matching tools found. Continue with the tools you have.')
  assert.deepEqual(requests, ['fetch a web page'])
  assert.match(toolSearch.description, /don't search for: fetch web page, search the web\.$/)
})

test('file tools only access files inside the working directory', async t => {
  const outside = await tmp(t)
  const dir = await tmp(t)
  await write.run({ path: join(outside, 'secret.txt'), content: 'secret' })
  await write.run({ path: join(dir, 'a.txt'), content: 'hello' })
  await symlink(outside, join(dir, 'link'))
  restrictFileTools(dir)
  t.after(() => restrictFileTools(undefined))

  assert.equal(await read.run({ path: join(dir, 'a.txt') }), 'hello')
  await write.run({ path: join(dir, 'new/b.txt'), content: 'b' })
  assert.equal(await read.run({ path: join(dir, 'new/b.txt') }), 'b')

  const outsideError = /is outside the working directory/
  await assert.rejects(read.run({ path: join(outside, 'secret.txt') }), outsideError)
  await assert.rejects(read.run({ path: `${dir}/../${basename(outside)}/secret.txt` }), outsideError)
  // Symlinks are followed, also for files that don't exist yet
  await assert.rejects(read.run({ path: join(dir, 'link/secret.txt') }), outsideError)
  await assert.rejects(write.run({ path: join(dir, 'link/new.txt'), content: 'x' }), outsideError)
  await assert.rejects(edit.run({ path: join(outside, 'secret.txt'), old_string: 'secret', new_string: 'x' }), outsideError)
  await assert.rejects(ls.run({ path: outside }), outsideError)
  await assert.rejects(grep.run({ pattern: 'secret', path: outside }), outsideError)
  assert.equal(await grep.run({ pattern: 'secret', path: dir, include: '**' }), 'No matches found')
  assert.doesNotMatch(await glob.run({ pattern: '../*', path: dir }), new RegExp(basename(outside)))
  assert.doesNotMatch(await ls.run({ path: dir }), /link/)
  assert.equal(await readFile(join(outside, 'secret.txt'), 'utf8'), 'secret')
})

test('file tools refuse writing into .git', async t => {
  const dir = await tmp(t)
  await mkdir(join(dir, '.git/hooks'), { recursive: true })
  restrictFileTools(dir)
  t.after(() => restrictFileTools(undefined))

  await assert.rejects(write.run({ path: join(dir, '.git/hooks/pre-commit'), content: '#!/bin/sh\necho hi' }), /inside a \.git directory/)
  await write.run({ path: join(dir, 'ok.txt'), content: 'x' })
  await assert.rejects(edit.run({ path: join(dir, '.git/config'), old_string: 'a', new_string: 'b' }), /inside a \.git directory/)
})

test('bash returns output and exit code', async () => {
  assert.equal(await bash.run({ command: 'echo hi' }), 'hi\n')
  assert.match(await bash.run({ command: 'echo oops >&2; exit 3' }), /oops\n\n\[exit 3\]/)
})

test('bash does not see secret environment variables', async t => {
  process.env.AGENT_API_KEY = 'sk-secret'
  process.env.MY_TOKEN = 'tok'
  process.env.PLAIN_VAR = 'visible'
  t.after(() => { delete process.env.AGENT_API_KEY; delete process.env.MY_TOKEN; delete process.env.PLAIN_VAR })

  assert.equal(await bash.run({ command: 'printf %s "${AGENT_API_KEY:-none}"' }), 'none')
  assert.equal(await bash.run({ command: 'printf %s "${MY_TOKEN:-none}"' }), 'none')
  assert.equal(await bash.run({ command: 'printf %s "${PLAIN_VAR:-none}"' }), 'visible')
})

test('grep bounds the input a pattern runs against', async t => {
  const dir = await tmp(t)
  // A long line with a pattern prone to catastrophic backtracking
  await write.run({ path: join(dir, 'big.txt'), content: `${'a'.repeat(5000)}!` })
  const start = Date.now()
  const out = await grep.run({ pattern: '(a+)+$', path: join(dir, 'big.txt') })
  // The cap cuts the input the regex sees, so the pathological match returns fast
  assert.ok(Date.now() - start < 2000, 'grep should not hang on a long line')
  assert.match(out, /big\.txt:1:/)
})

test('write and read round trip', async t => {
  const path = join(await tmp(t), 'nested', 'file.txt')

  await write.run({ path, content: 'hello' })

  assert.equal(await read.run({ path }), 'hello')
})

test('read supports offset and limit', async t => {
  const path = join(await tmp(t), 'lines.txt')
  await write.run({ path, content: 'a\nb\nc\nd' })

  assert.equal(await read.run({ path, offset: 2, limit: 2 }), 'b\nc\n[1 more lines, continue with offset 4]')
  assert.equal(await read.run({ path, offset: 3 }), 'c\nd')
})

test('edit replaces a unique string', async t => {
  const path = join(await tmp(t), 'file.txt')
  await write.run({ path, content: 'one two three' })

  await edit.run({ path, old_string: 'two', new_string: '$& 2' })

  assert.equal(await readFile(path, 'utf8'), 'one $& 2 three')
})

test('edit rejects missing and ambiguous matches unless replace_all', async t => {
  const path = join(await tmp(t), 'file.txt')
  await write.run({ path, content: 'a a' })

  await assert.rejects(edit.run({ path, old_string: 'b', new_string: 'c' }), /not found/)
  await assert.rejects(edit.run({ path, old_string: 'a', new_string: 'c' }), /found 2 times/)
  assert.equal(await edit.run({ path, old_string: 'a', new_string: 'c', replace_all: true }), `Replaced 2 occurrences in ${path}`)
  assert.equal(await readFile(path, 'utf8'), 'c c')
})

test('glob finds files with sizes and never searches node_modules', async t => {
  const dir = await tmp(t)
  await write.run({ path: join(dir, 'src/a.ts'), content: 'x' })
  await write.run({ path: join(dir, 'src/b.js'), content: '' })
  await write.run({ path: join(dir, 'node_modules/c.ts'), content: '' })

  assert.equal(await glob.run({ pattern: '**/*.ts', path: dir }), `${join(dir, 'src/a.ts')} (1 B)`)
  assert.equal(await glob.run({ pattern: '{*.js,*/*.js}', path: dir }), `${join(dir, 'src/b.js')} (0 B)`)
  assert.equal(await glob.run({ pattern: '*.md', path: dir }), 'No files found')
})

test('glob lists directories including hidden files', async t => {
  const dir = await tmp(t)
  await write.run({ path: join(dir, 'src/a.ts'), content: '' })
  await write.run({ path: join(dir, 'src/.env.ts'), content: '' })
  await write.run({ path: join(dir, 'node_modules/c.ts'), content: '' })
  await write.run({ path: join(dir, '.git/config'), content: '' })
  await write.run({ path: join(dir, '.gitignore'), content: 'node_modules\n' })

  const listing = [
    `${join(dir, '.git')}/`,
    `${join(dir, '.gitignore')} (13 B)`,
    `${join(dir, 'node_modules')}/`,
    `${join(dir, 'src')}/`
  ].join('\n')
  assert.equal(await glob.run({ path: dir }), listing)
  assert.equal(await glob.run({ pattern: '*', path: dir }), listing)
  assert.equal(await ls.run({ path: dir }), listing)
  assert.equal(await glob.run({ pattern: 'src/*.ts', path: dir }), `${join(dir, 'src/.env.ts')} (0 B)\n${join(dir, 'src/a.ts')} (0 B)`)
})

test('grep searches file contents', async t => {
  const dir = await tmp(t)
  await write.run({ path: join(dir, 'a.ts'), content: 'const x = 1\nfunction hello () {}' })
  await write.run({ path: join(dir, 'b.md'), content: 'hello docs' })
  await write.run({ path: join(dir, 'node_modules/c.ts'), content: 'hello dep' })

  assert.equal(
    await grep.run({ pattern: 'hel+o', path: dir }),
    `${join(dir, 'a.ts')}:2: function hello () {}\n${join(dir, 'b.md')}:1: hello docs`
  )
  assert.equal(await grep.run({ pattern: 'hello', path: dir, include: '*.md' }), `${join(dir, 'b.md')}:1: hello docs`)
  assert.equal(await grep.run({ pattern: 'x', path: join(dir, 'a.ts') }), `${join(dir, 'a.ts')}:1: const x = 1`)
  assert.equal(await grep.run({ pattern: 'nope', path: dir }), 'No matches found')
})
