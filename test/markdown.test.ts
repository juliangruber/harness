import { test } from 'node:test'
import assert from 'node:assert/strict'
import { styleText } from 'node:util'
import { renderMarkdown } from '../src/markdown.ts'

test('styles inline markdown', () => {
  const s = (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { validateStream: false })

  assert.equal(
    renderMarkdown('**a** *b* `c`', { color: true }),
    `${s('bold', 'a')} ${s('italic', 'b')} ${s('cyan', 'c')}`
  )
})

test('highlights matching headings and paragraphs', () => {
  const s = (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { validateStream: false })

  assert.equal(
    renderMarkdown('Answer\n\n**Sources:**\n\n## Suggested web searches', { color: true, highlight: /^(sources|suggested web searches):?$/i }),
    `Answer\n\n${s(['bold', 'cyan'], 'Sources:')}\n\n${s(['bold', 'cyan'], 'Suggested web searches')}`
  )
})

test('renders block markdown as plain text without color', () => {
  const markdown = `# Title

Some **bold** & [a link](https://example.com).

- [x] done
- two
  1. nested

> quote

\`\`\`js
if (a < b) {}
\`\`\`

| a | bb |
|---|---|
| ccc | d |`

  assert.equal(renderMarkdown(markdown, { color: false }), `Title

Some bold & a link (https://example.com).

- [x] done
- two
  1. nested

│ quote

  if (a < b) {}

a   │ bb
────┼───
ccc │ d`)
})
