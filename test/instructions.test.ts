import { test, type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findInstructions, resolveInstructions } from '../src/instructions.ts'

async function tmp (t: TestContext): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'harness-'))
  t.after(() => rm(dir, { recursive: true }))
  return dir
}

const noAsk = async (): Promise<string> => { throw new Error('should not ask') }

test('finds AGENTS.md before AGENT.md before CLAUDE.md, case insensitively', async t => {
  const dir = await tmp(t)
  assert.equal(await findInstructions(dir), undefined)

  await writeFile(join(dir, 'claude.md'), 'claude')
  assert.deepEqual(await findInstructions(dir), { path: join(dir, 'claude.md'), content: 'claude' })

  await writeFile(join(dir, 'Agent.md'), 'agent')
  assert.equal((await findInstructions(dir))?.content, 'agent')

  await writeFile(join(dir, 'AGENTS.md'), 'agents')
  assert.equal((await findInstructions(dir))?.content, 'agents')
})

test('uses instructions only when trusted', async t => {
  const dir = await tmp(t)
  await writeFile(join(dir, 'AGENTS.md'), 'be nice')
  const warnings: string[] = []
  const warn = (text: string) => { warnings.push(text) }

  assert.equal((await resolveInstructions(dir, { trust: true, ask: noAsk, warn }))?.content, 'be nice')

  const questions: string[] = []
  const answer = (reply: string) => async (question: string) => { questions.push(question); return reply }
  assert.equal((await resolveInstructions(dir, { trust: false, ask: answer('y'), warn }))?.content, 'be nice')
  assert.equal(await resolveInstructions(dir, { trust: false, ask: answer(''), warn }), undefined)
  assert.equal(await resolveInstructions(dir, { trust: false, ask: answer('nope'), warn }), undefined)
  assert.match(questions[0], /^Found .*AGENTS\.md for review:\n {2}be nice\nUse these instructions\? \[y\/N\] $/)

  assert.equal(await resolveInstructions(dir, { trust: false, warn }), undefined)
  assert.match(warnings[0], /Ignoring .*AGENTS\.md.*--trust/)
})
