import { lexer, type Token, type Tokens } from 'marked'
import { stripVTControlCharacters, styleText } from 'node:util'

type Format = Parameters<typeof styleText>[0]

export type RenderOptions = {
  // true forces styles, false strips them, undefined styles only when the stream supports it
  color?: boolean
  // Stream the output is written to, defaults to stdout
  stream?: NodeJS.WriteStream
  // Headings and paragraphs whose text matches are highlighted
  highlight?: RegExp
}

// Renders markdown for the terminal: marked parses, util.styleText styles
export function renderMarkdown (markdown: string, { color, stream, highlight }: RenderOptions = {}): string {
  const style = (format: Format, text: string) =>
    color === false ? text : styleText(format, text, { validateStream: color === undefined, stream })

  const inline = (tokens: Token[] = []): string => tokens.map(token => {
    switch (token.type) {
      case 'strong': return style('bold', inline(token.tokens))
      case 'em': return style('italic', inline(token.tokens))
      case 'del': return style('strikethrough', inline(token.tokens))
      case 'codespan': return style('cyan', token.text)
      case 'link': {
        const text = inline(token.tokens)
        return text === token.href
          ? style('underline', text)
          : `${style('underline', text)} ${style('dim', `(${token.href})`)}`
      }
      case 'image': return style('dim', `[image: ${token.text}]`)
      case 'br': return '\n'
      case 'text': return token.tokens ? inline(token.tokens) : token.text
      default: return 'text' in token ? token.text : token.raw
    }
  }).join('')

  const block = (tokens: Token[] = [], separator = '\n\n'): string =>
    tokens.map(render).filter(Boolean).join(separator)

  const highlighted = (text: string): string | undefined => {
    const plain = stripVTControlCharacters(text)
    return highlight?.test(plain) ? style(['bold', 'cyan'], plain) : undefined
  }

  const render = (token: Token): string => {
    switch (token.type) {
      case 'heading': {
        const text = inline(token.tokens)
        return highlighted(text) ?? style(token.depth === 1 ? ['bold', 'underline'] : 'bold', text)
      }
      case 'paragraph': {
        const text = inline(token.tokens)
        return highlighted(text) ?? text
      }
      case 'text': return token.tokens ? inline(token.tokens) : token.text
      case 'code': return token.text.split('\n').map((line: string) => `  ${style('yellow', line)}`).join('\n')
      case 'blockquote': return block(token.tokens).split('\n').map(line => `${style('dim', '│')} ${line}`).join('\n')
      case 'list': return renderList(token as Tokens.List)
      case 'table': return renderTable(token as Tokens.Table)
      case 'hr': return style('dim', '─'.repeat(40))
      case 'space':
      case 'def': return ''
      default: return 'text' in token ? token.text : token.raw
    }
  }

  const renderList = (list: Tokens.List): string => list.items.map((item, i) => {
    const bullet = list.ordered ? `${Number(list.start || 1) + i}.` : '-'
    const checkbox = item.task ? `[${item.checked ? 'x' : ' '}] ` : ''
    const body = block(item.tokens.filter(t => t.type !== 'checkbox'), list.loose ? '\n\n' : '\n')
    return `${bullet} ${checkbox}${indent(body, bullet.length + 1).slice(bullet.length + 1)}`
  }).join(list.loose ? '\n\n' : '\n')

  const renderTable = (table: Tokens.Table): string => {
    const header = table.header.map(cell => style('bold', inline(cell.tokens)))
    const rows = table.rows.map(row => row.map(cell => inline(cell.tokens)))
    const widths = header.map((_, i) => Math.max(...[header, ...rows].map(row => width(row[i]))))
    const line = (row: string[]) =>
      row.map((cell, i) => cell + ' '.repeat(widths[i] - width(cell))).join(style('dim', ' │ ')).trimEnd()
    const divider = style('dim', widths.map(w => '─'.repeat(w)).join('─┼─'))
    return [line(header), divider, ...rows.map(line)].join('\n')
  }

  return block(lexer(markdown))
}

const width = (text = ''): number => stripVTControlCharacters(text).length

const indent = (text: string, n: number): string =>
  text.split('\n').map(line => line && ' '.repeat(n) + line).join('\n')
