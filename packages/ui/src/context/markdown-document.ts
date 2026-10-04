import type { Marked, Token, Tokens } from "marked"
import { prepareMarkdownMath } from "./marked-math"

export interface MarkdownBlock {
  html: string
  codeID?: string
}
export interface MarkdownDocument {
  blocks: MarkdownBlock[]
  codes: Record<string, string>
}
const CHARS = 8192
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function splitText(text: string) {
  const parts: string[] = []
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + CHARS)
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    const amp = text.lastIndexOf("&", end - 1)
    if (amp >= start && end - amp < 32 && !text.slice(amp, end).includes(";")) end = amp > start ? amp : end
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

function splitInline(tokens: Token[]): Token[][] {
  const chunks: Token[][] = []
  let current: Token[] = []
  let chars = 0
  const append = (token: Token, size: number) => {
    if (current.length && (chars + size > CHARS || current.length >= 32)) {
      chunks.push(current)
      current = []
      chars = 0
    }
    current.push(token)
    chars += size
  }
  for (const token of tokens) {
    if ("tokens" in token && Array.isArray(token.tokens)) {
      for (const child of splitInline(token.tokens))
        append(
          { ...token, tokens: child },
          child.reduce((sum, item) => sum + item.raw.length, 0),
        )
    } else if (
      "text" in token &&
      typeof token.text === "string" &&
      token.text.length > CHARS &&
      ["text", "escape", "codespan"].includes(token.type)
    ) {
      for (const text of splitText(token.text)) append({ ...token, text, raw: text }, text.length)
    } else append(token, token.raw.length)
  }
  if (current.length) chunks.push(current)
  return chunks
}

export async function parseMarkdownDocument(
  parser: Marked,
  markdown: string,
  cancelled: () => boolean = () => false,
): Promise<MarkdownDocument> {
  const document: MarkdownDocument = { blocks: [], codes: {} }
  const codeIDs = new WeakMap<Token, string>()
  const plain = (raw: string): Tokens.HTML[] =>
    splitText(raw).map((text) => ({
      type: "html",
      raw: text,
      block: true,
      pre: true,
      text: `<pre data-slot="markdown-render-fallback">${escape(text)}</pre>`,
    }))
  const expand = (token: Token): Token[] => {
    if (token.type === "code" && (token.text.length > CHARS || token.text.split("\n", 162).length > 160)) {
      const id = `code-${Object.keys(document.codes).length}`
      document.codes[id] = token.text
      return splitText(token.text).map((text) => {
        const chunk: Tokens.HTML = {
          type: "html",
          block: true,
          pre: true,
          raw: text,
          text: `<div data-slot="markdown-code-block"><pre class="shiki" data-language="text"><code>${escape(text)}</code></pre></div>`,
        }
        codeIDs.set(chunk, id)
        return chunk
      })
    }
    if (token.type === "list") {
      const list = token as Tokens.List
      if (list.items.some((item) => item.raw.length > CHARS * 2)) return plain(list.raw)
      const output: Token[] = []
      for (let index = 0; index < list.items.length; ) {
        const start = index
        let bytes = 0
        while (
          index < list.items.length &&
          index - start < 16 &&
          (!bytes || bytes + list.items[index].raw.length <= CHARS * 2)
        )
          bytes += list.items[index++].raw.length
        const items = list.items.slice(start, index)
        output.push({
          ...list,
          items,
          start: typeof list.start === "number" ? list.start + start : list.start,
          raw: items.map((item) => item.raw).join(""),
        })
      }
      return output
    }
    if (token.type === "table") {
      const table = token as Tokens.Table
      if (
        [table.header, ...table.rows].some(
          (row) => row.length > 64 || row.reduce((sum, cell) => sum + cell.text.length, 0) > CHARS * 2,
        )
      )
        return plain(table.raw)
      const output: Tokens.Table[] = []
      const headerSize = table.header.reduce((sum, cell) => sum + cell.text.length, 0)
      if (!table.rows.length) return [table]
      for (let index = 0; index < table.rows.length; ) {
        const start = index
        let chars = headerSize
        while (index < table.rows.length && index - start < 16) {
          const size = table.rows[index].reduce((sum, cell) => sum + cell.text.length, 0)
          if (index > start && chars + size > CHARS * 2) break
          chars += size
          index++
        }
        output.push({ ...table, rows: table.rows.slice(start, index), raw: "" })
      }
      return output
    }
    if (token.type === "blockquote")
      return (token as Tokens.Blockquote).tokens
        .flatMap(expand)
        .map((child) => ({ ...token, tokens: [child], raw: child.raw }))
    if ((token.type === "paragraph" || token.type === "text") && token.tokens)
      return splitInline(token.tokens).map((tokens) => ({
        ...token,
        tokens,
        raw: tokens.map((item) => item.raw).join(""),
      }))
    if (token.raw.length > CHARS * 2 && token.type !== "space") return plain(token.raw)
    return [token]
  }
  const options = parser.defaults
  const hooks = options.hooks
  if (hooks) {
    hooks.options = options
    hooks.block = true
  }
  const prepared = hooks ? await hooks.preprocess(markdown) : prepareMarkdownMath(markdown)
  let tokens: Token[] = parser.lexer(prepared, options)
  if (hooks) tokens = await hooks.processAllTokens(tokens)
  const expanded = tokens.flatMap(expand)
  for (let index = 0; index < expanded.length; ) {
    if (cancelled()) throw new DOMException("Markdown document cancelled", "AbortError")
    const group: Token[] = []
    let chars = 0
    while (index < expanded.length && group.length < 16) {
      const token = expanded[index]!
      const isolated = (item: Token) => codeIDs.has(item) || ["list", "table", "blockquote", "code"].includes(item.type)
      if (group.length && (chars + token.raw.length > CHARS * 2 || isolated(token) || isolated(group[0]!))) break
      group.push(token)
      chars += token.raw.length
      index++
    }
    if (options.walkTokens) await Promise.all(parser.walkTokens(group, options.walkTokens))
    let html = parser.parser(group, options)
    if (hooks) html = await hooks.postprocess(html)
    if (html) document.blocks.push({ html, codeID: codeIDs.get(group[0]!) })
    if (document.blocks.length % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return document
}
