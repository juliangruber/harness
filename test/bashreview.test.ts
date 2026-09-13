import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reviewBashCommand, withBashReview, type BashReview } from '../src/bashreview.ts'
import type { ChatClient, Message, ToolSchema } from '../src/llm.ts'
import type { Tool } from '../src/tools.ts'

const tool = (name: string, description: string): Tool => ({ name, description, parameters: {}, run: async () => '' })
const alternatives = [tool('ls', 'List a directory'), tool('glob', 'Find files by pattern')]

// A model answering with the given text, recording what it was asked
function model (answer: string) {
  const requests: { messages: Message[], tools: ToolSchema[] }[] = []
  const client: ChatClient = {
    async chat (messages, tools) {
      requests.push({ messages, tools })
      return { role: 'assistant', content: answer }
    }
  }
  return { client, requests }
}

function reviewed (client: ChatClient) {
  const ran: string[] = []
  const bash: Tool = { ...tool('bash', 'Run a command'), run: async ({ command }) => { ran.push(command); return `ran ${command}` } }
  const reviews: BashReview[] = []
  const reviewedBash = withBashReview(bash, { client, tools: alternatives, cwd: '/work', onReview: (_, review) => reviews.push(review) })
  return { tool: reviewedBash, ran, reviews }
}

test('one request checks whether other tools fit and whether the command is safe', async () => {
  const { client, requests } = model('{"use_tools": false, "reason": "runs the test suite", "safe": true, "safety": "only runs tests"}')
  const { tool, ran, reviews } = reviewed(client)

  assert.equal(await tool.run({ command: 'npm test' }), 'ran npm test')

  assert.deepEqual(ran, ['npm test'])
  assert.deepEqual(reviews, [{ useTools: false, tools: [], reason: 'runs the test suite', safe: true, safety: 'only runs tests' }])
  assert.equal(requests.length, 1)
  assert.deepEqual(requests[0].tools, [])
  const prompt = requests[0].messages[0].content!
  assert.match(prompt, /The working directory is \/work\./)
  assert.match(prompt, /- ls: List a directory\n- glob: Find files by pattern/)
  assert.match(prompt, /Is the command safe to run\?/)
  assert.equal(requests[0].messages[1].content, 'Command:\nnpm test')
})

test('bash is refused when the other tools can do the same', async () => {
  const { client } = model('```json\n{"use_tools": true, "tools": ["ls", "glob", "made_up"], "reason": "It only lists files.", "safe": true, "safety": "read only"}\n```')
  const { tool, ran, reviews } = reviewed(client)

  await assert.rejects(tool.run({ command: 'cd /work && ls -la' }), /^Error: bash refused: It only lists files\. Use ls, glob instead\.$/)

  assert.deepEqual(ran, [])
  assert.deepEqual(reviews[0].tools, ['ls', 'glob'])
})

test('bash is refused when the command is unsafe', async () => {
  const { client } = model('{"use_tools": false, "reason": "deletes files", "safe": false, "safety": "deletes the home directory."}')
  const { tool, ran } = reviewed(client)

  await assert.rejects(tool.run({ command: 'rm -rf ~' }), /^Error: bash refused as unsafe: deletes the home directory\. Don't retry it\. If it's needed, ask the user to run it themselves\.$/)
  assert.deepEqual(ran, [])
})

test('an unsafe command is refused as unsafe, even if other tools could do it', async () => {
  const { client } = model('{"use_tools": true, "tools": ["read"], "reason": "read can read files", "safe": false, "safety": "reads an SSH key"}')
  const { tool, ran } = reviewed(client)

  await assert.rejects(tool.run({ command: 'cat ~/.ssh/id_rsa' }), /^Error: bash refused as unsafe: reads an SSH key\./)
  assert.deepEqual(ran, [])
})

test('a failed check refuses the command', async () => {
  const failing: ChatClient = { chat: async () => { throw new Error('LLM down') } }
  const failed = { useTools: false, tools: [], reason: 'the check couldn\'t decide', safe: false, safety: 'the check couldn\'t verify the command is safe' }

  assert.deepEqual(await reviewBashCommand('npm test', { client: failing, tools: alternatives }), failed)
  assert.deepEqual(await reviewBashCommand('npm test', { client: model('no json here').client, tools: alternatives }), failed)
  // An answer without "safe" isn't safe
  assert.equal((await reviewBashCommand('npm test', { client: model('{"use_tools": false}').client, tools: alternatives })).safe, false)

  const { tool, ran } = reviewed(model('not json').client)
  await assert.rejects(tool.run({ command: 'npm test' }), /bash refused as unsafe: the check couldn't verify the command is safe/)
  assert.deepEqual(ran, [])
})
