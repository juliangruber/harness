import { test } from 'node:test'
import assert from 'node:assert/strict'
import { styleText } from 'node:util'
import { renderMarkdown, stripControl } from '../src/markdown.ts'

test('styles inline markdown', () => {
  const s = (format: Parameters<typeof styleText>[0], text: string) =>
    styleText(format, text, { validateStream: false })

  assert.equal(
    renderMarkdown('**a** *b* `c`', { color: true }),
    `${s('bold', 'a')} ${s('italic', 'b')} ${s('cyan', 'c')}`
  )
})

test('strips control bytes, keeping newlines and tabs, leaving text inert', () => {
  // The escape byte goes, so the terminal never interprets the sequence
  assert.equal(stripControl('a\x1b[8mhidden\x1b[0m\tb\nc\rd'), 'a[8mhidden[0m\tb\ncd')
  assert.equal(stripControl('title\x1b]0;pwned\x07end'), 'title]0;pwnedend')
  // A single-byte C1 CSI (0x9b) is a control char and is stripped
  assert.equal(stripControl('x\u009b2Ky'), 'x2Ky')
})

test('rendered markdown carries no escape sequences from the model', () => {
  const evil = 'Done.\x1b]0;pwned\x07\x1b[2K\rInjected'
  const out = renderMarkdown(evil, { color: false })
  assert.doesNotMatch(out, /[\x1b\x07\r]/)
  assert.match(out, /Injected/)
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
