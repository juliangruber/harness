import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { fakeServer } from './helpers.ts'

const run = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url))

test('cli runs a prompt end to end', async t => {
  const server = await fakeServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo from-bash"}' } }]
    },
    // The bash check, a separate request
    { role: 'assistant', content: '{"use_tools": false, "reason": "prints a message", "safe": true, "safety": "only prints"}' },
    { role: 'assistant', content: 'all done' }
  ])
  t.after(server.close)

  const { stdout, stderr } = await run('node', ['src/cli.ts', 'say hi'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl, AGENT_MODEL: 'test-model' }
  })

  assert.equal(stdout, 'all done\n')
  assert.match(stderr, /\[bash\] {"command":"echo from-bash"}\nWARNING: bash used: prints a message/)
  assert.equal(server.requests[0].body.model, 'test-model')
  assert.equal(server.requests[1].body.messages.at(-1).content, 'Command:\necho from-bash')
  assert.equal(server.requests[2].body.messages.at(-1).content, 'from-bash\n')
})

test('cli limits file tools to the working directory', async t => {
  const server = await fakeServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/etc/hosts"}' } }]
    },
    { role: 'assistant', content: 'done' }
  ])
  t.after(server.close)

  await run('node', ['src/cli.ts', 'read the hosts file'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })

  assert.match(server.requests[1].body.messages.at(-1).content, /^Error: \/etc\/hosts is outside the working directory/)
})

test('cli --unsafe runs bash without checks', async t => {
  const server = await fakeServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'bash', arguments: '{"command":"echo unchecked"}' } }]
    },
    { role: 'assistant', content: 'all done' }
  ])
  t.after(server.close)

  const { stdout, stderr } = await run('node', ['src/cli.ts', '--unsafe', 'say hi'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })

  assert.equal(stdout, 'all done\n')
  assert.match(stderr, /^WARNING: --unsafe: bash commands run without checks, and file tools can access files outside the working directory\. Only use this in a container\.\n/)
  assert.doesNotMatch(stderr, /bash (used|refused)/)
  assert.equal(server.requests.length, 2)
  assert.doesNotMatch(server.requests[0].body.messages[0].content, /round trip/)
  assert.equal(server.requests[1].body.messages.at(-1).content, 'unchecked\n')
})

test('cli prints tool requests as TODOs after the answer', async t => {
  const server = await fakeServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'tool_search', arguments: '{"description":"search the web"}' } },
        { id: 'call_2', type: 'function', function: { name: 'web_search', arguments: '{"query":"love"}' } }
      ]
    },
    { role: 'assistant', content: 'no search' }
  ])
  t.after(server.close)

  const { stdout, stderr } = await run('node', ['src/cli.ts', 'what is love'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })

  assert.equal(stdout, 'no search\n')
  assert.match(stderr, /TODO: add tool: search the web\n.*TODO: add tool: web_search {"query":"love"}\n$/)
  const toolResults = server.requests[1].body.messages.slice(-2).map((m: { content: string }) => m.content)
  assert.deepEqual(toolResults, [
    'No matching tools found. Continue with the tools you have.',
    'Error: unknown tool web_search. Use tool_search to find more tools.'
  ])
})

test('cli --debug logs the system prompt', async t => {
  const server = await fakeServer([{ role: 'assistant', content: 'hi' }])
  t.after(server.close)

  const { stdout, stderr } = await run('node', ['src/cli.ts', '--debug', 'hello'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })

  assert.equal(stdout, 'hi\n')
  assert.match(stderr, /--- system ---\nYou are a helpful assistant/)
  assert.match(stderr, /--- user ---\nhello\n/)
  assert.match(stderr, /--- assistant ---\nhi\n=== answer ===\n$/)
})

test('cli only uses AGENTS.md with --trust when it cannot ask', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'harness-'))
  t.after(() => rm(dir, { recursive: true }))
  await writeFile(join(dir, 'AGENTS.md'), 'Always answer in German.')
  const server = await fakeServer([{ role: 'assistant', content: 'hi' }, { role: 'assistant', content: 'hallo' }])
  t.after(server.close)
  const options = { cwd: dir, env: { ...process.env, AGENT_BASE_URL: server.baseUrl } }

  const untrusted = await run('node', [cli, 'hello'], options)
  assert.match(untrusted.stderr, /Ignoring .*AGENTS\.md.*--trust/)
  assert.doesNotMatch(server.requests[0].body.messages[0].content, /German/)

  const trusted = await run('node', [cli, '--trust', 'hello'], options)
  assert.doesNotMatch(trusted.stderr, /Ignoring/)
  assert.match(server.requests[1].body.messages[0].content, /Instructions from .*AGENTS\.md:\nAlways answer in German\.$/)
})

test('cli adds research sources and suggested web searches the answer left out', async t => {
  // The main agent and the research agent share the fake server
  const server = await fakeServer([
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'research', arguments: '{"question":"What is love?"}' } }]
    },
    { role: 'assistant', content: 'A feeling.\n\nSources:\n- https://en.wikipedia.org/wiki/Love\n\nSuggested web searches:\n- love psychology research' },
    { role: 'assistant', content: 'Love is a feeling.' }
  ])
  t.after(server.close)

  const { stdout } = await run('node', [cli, 'what is love'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })

  assert.equal(stdout, 'Love is a feeling.\n\nSources:\n\n- https://en.wikipedia.org/wiki/Love\n\nSuggested web searches:\n\n- love psychology research\n')
})

test('cli interactive mode keeps the conversation', async t => {
  const server = await fakeServer([
    { role: 'assistant', content: 'one' },
    { role: 'assistant', content: 'two' }
  ])
  t.after(server.close)

  const child = execFile('node', ['src/cli.ts'], {
    env: { ...process.env, AGENT_BASE_URL: server.baseUrl }
  })
  child.stdin?.end('first\nsecond\n')
  let stdout = ''
  child.stdout?.on('data', chunk => { stdout += chunk })
  const [code] = await once(child, 'close')

  assert.equal(code, 0)
  assert.equal(stdout, '> one\n> two\n> ')
  assert.deepEqual(
    server.requests[1].body.messages.slice(1).map((m: { content: string }) => m.content),
    ['first', 'one', 'second']
  )
})
