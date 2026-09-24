import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiPath, createGithubTool } from '../src/github.ts'

// Fake gh that prints its arguments, or the given output
async function fakeGh (t: TestContext, script = 'printf "%s\\n" "$@"'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-'))
  t.after(() => rm(dir, { recursive: true }))
  const path = join(dir, 'gh')
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
  return path
}

test('apiPath only allows paths on the GitHub API', () => {
  assert.equal(apiPath('repos/a/b/issues'), '/repos/a/b/issues')
  assert.equal(apiPath('/search/issues?per_page=5', { q: 'repo:a/b is:open' }), '/search/issues?per_page=5&q=repo%3Aa%2Fb+is%3Aopen')
  // Would otherwise be taken for a flag, like -XPOST
  assert.equal(apiPath('-XPOST'), '/-XPOST')
  assert.equal(apiPath('//evil.example/x'), '/evil.example/x')
  assert.throws(() => apiPath('https://evil.example/x'), /not a GitHub API path/)
})

test('github makes GET requests with gh', async t => {
  const github = createGithubTool({ command: await fakeGh(t) })
  assert.equal(await github.run({ endpoint: 'repos/a/b/issues', query: { state: 'open' } }), 'api\n--method\nGET\n--\n/repos/a/b/issues?state=open\n')
  assert.equal(await github.run({ endpoint: 'repos/a/b', jq: '.name' }), 'api\n--method\nGET\n--jq\n.name\n--\n/repos/a/b\n')
})

test('github decodes file contents', async t => {
  const body = JSON.stringify({ path: 'a.txt', encoding: 'base64', content: Buffer.from('hello').toString('base64') })
  const github = createGithubTool({ command: await fakeGh(t, `echo '${body}'`) })
  const file = JSON.parse(await github.run({ endpoint: 'repos/a/b/contents/a.txt' }))
  assert.deepEqual(file, { path: 'a.txt', encoding: 'utf8', content: 'hello' })
})

test('github returns errors to the model', async t => {
  const github = createGithubTool({ command: await fakeGh(t, 'echo \'{"message":"Not Found"}\'; echo "gh: Not Found (HTTP 404)" >&2; exit 1') })
  assert.equal(await github.run({ endpoint: 'repos/a/nope' }), '{"message":"Not Found"}\n\ngh: Not Found (HTTP 404)\n[exit 1]')
  await assert.rejects(createGithubTool({ command: 'harness-missing-gh' }).run({ endpoint: 'repos/a/b' }), /gh CLI is not installed/)
})
