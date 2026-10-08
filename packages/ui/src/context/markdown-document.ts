import type { RendererObject, Token, Tokens } from "marked"
import type { createMarkdownParser } from "./markdown-parser"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"
import { prepareMarkdownMathSource } from "./marked-math"
import {
  markdownRawRange,
  markdownRawSpans,
  markdownContentSpans,
  markdownComposeSpans,
  markdownTableCells,
  markdownSliceSpans,
  markdownTextReadingSpans,
  type MarkdownSourceRange,
  type MarkdownSourceSpan,
  type MarkdownReadingRun,
} from "./markdown-source"

export interface MarkdownBlock {
  html: string
  codeID?: string
  source: MarkdownSourceRange
}
export interface MarkdownDocument {
  blocks: MarkdownBlock[]
  codes: Record<string, string>
  reading?: { marker: string; runs: MarkdownReadingRun[] }
}
const CHARS = 8192
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")

function splitText(text: string) {
  const parts: string[] = []
  const segments = /[^\x00-\x7F]|\r/.test(text)
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)[Symbol.iterator]()
    : undefined
  let next = segments?.next()
  for (let start = 0; start < text.length; ) {
    let end = Math.min(text.length, start + CHARS)
    const amp = text.lastIndexOf("&", end - 1)
    if (amp >= start && end - amp < 32 && !text.slice(amp, end).includes(";")) end = amp > start ? amp : end
    while (next && !next.done && next.value.index < end) {
      const segmentEnd = next.value.index + next.value.segment.length
      if (segmentEnd > end) {
        end = next.value.index > start ? next.value.index : segmentEnd
        if (end === segmentEnd) next = segments!.next()
        break
      }
      next = segments!.next()
    }
    parts.push(text.slice(start, end))
    start = end
  }
  return parts
}

export function createMarkdownFallbackDocument(markdown: string): MarkdownDocument {
  const marker = generateUUID()
  const normalized = markdown.replace(/\r\n|\r/g, "\n")
  const whole = markdownRawSpans(markdown, normalized, 0, markdown.length)
  const runs: MarkdownReadingRun[] = []
  let offset = 0
  const blocks = splitText(normalized).map((text) => {
    const spans = markdownSliceSpans(whole, offset, offset + text.length)
    const source = { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length }
    const id = runs.push({ source, spans }) - 1
    offset += text.length
    return {
      source,
      html: `<pre data-slot="markdown-render-fallback"><code><span data-markdown-reading="${marker}:${id}">${escape(text)}</span></code></pre>`,
    }
  })
  return { blocks, codes: {}, reading: { marker, runs } }
}

function splitInline(
  tokens: Token[],
  sources: WeakMap<Token, MarkdownSourceRange>,
  origins: WeakMap<Token, MarkdownSourceSpan[]>,
  contents: WeakMap<Token, MarkdownSourceSpan[]>,
): Token[][] {
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
    if (token.type !== "image" && "tokens" in token && Array.isArray(token.tokens)) {
      for (const child of splitInline(token.tokens, sources, origins, contents)) {
        const next = { ...token, tokens: child }
        sources.set(next, { start: sources.get(child[0])!.start, end: sources.get(child.at(-1)!)!.end })
        append(
          next,
          child.reduce((sum, item) => sum + item.raw.length, 0),
        )
      }
    } else if (
      "text" in token &&
      typeof token.text === "string" &&
      token.text.length > CHARS &&
      ["text", "escape", "codespan"].includes(token.type)
    ) {
      let consumed = 0
      for (const text of splitText(token.text)) {
        const next = { ...token, text, raw: text }
        const spans = markdownSliceSpans(contents.get(token)!, consumed, consumed + text.length)
        const range = { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length }
        sources.set(next, range)
        origins.set(next, spans)
        contents.set(next, spans)
        consumed += text.length
        append(next, text.length)
      }
    } else append(token, token.raw.length)
  }
  if (current.length) chunks.push(current)
  return chunks
}

function admittedInline(tokens: readonly Token[]): boolean {
  return tokens.every((token) => {
    if (token.type === "image" && token.raw.length > CHARS * 2) return false
    if ("href" in token && token.href.length + ("title" in token ? (token.title?.length ?? 0) : 0) > CHARS) return false
    if (token.type === "image") return true
    return !("tokens" in token && token.tokens) || admittedInline(token.tokens)
  })
}

export async function parseMarkdownDocument(
  parser: ReturnType<typeof createMarkdownParser>,
  markdown: string,
  cancelled: () => boolean = () => false,
): Promise<MarkdownDocument> {
  const document: MarkdownDocument = { blocks: [], codes: {} }
  const reading = (document.reading = { marker: generateUUID(), runs: [] as MarkdownReadingRun[] })
  const origins = new WeakMap<Token, MarkdownSourceSpan[]>()
  const contentOrigins = new WeakMap<Token, MarkdownSourceSpan[]>()
  const headers = new WeakSet<Token>()
  const generatedPlain = new WeakSet<Token>()
  const continuationTables = new WeakSet<Token>()
  const codeIDs = new WeakMap<Token, string>()
  const sources = new WeakMap<Token, MarkdownSourceRange>()
  const prepared = prepareMarkdownMathSource(markdown)
  const assign = (tokens: Token[], range: MarkdownSourceRange) => {
    let offset = range.start
    for (const token of tokens) {
      const source = markdownRawRange(prepared.markdown, token.raw, offset, range.end)
      sources.set(token, source)
      origins.set(token, markdownRawSpans(prepared.markdown, token.raw, offset, range.end))
      if (
        ["code", "codespan", "escape", "text"].includes(token.type) &&
        "text" in token &&
        typeof token.text === "string" &&
        !("tokens" in token && token.tokens)
      )
        contentOrigins.set(
          token,
          markdownComposeSpans(
            markdownContentSpans(
              token.raw,
              token.raw,
              token.text,
              { start: 0, end: token.raw.length },
              token.type as "code" | "codespan" | "escape" | "text",
            ),
            origins.get(token)!,
          ),
        )
      if ("tokens" in token && Array.isArray(token.tokens)) assign(token.tokens, source)
      if (token.type === "table") {
        const lines = token.raw.split("\n")
        let rowOffset = 0
        for (let row = 0; row < lines.length; row++) {
          const table = token as Tokens.Table
          const cells = row === 0 ? table.header : row >= 2 ? table.rows[row - 2] : undefined
          if (cells) {
            const rowSpans = markdownSliceSpans(origins.get(token)!, rowOffset, rowOffset + lines[row].length)
            const consumed = markdownTableCells(
              prepared.markdown,
              rowSpans[0].source,
              rowSpans.at(-1)!.source + rowSpans.at(-1)!.length,
            )
            cells.forEach((cell, index) => {
              const owner = consumed[index]
              if (!owner) throw new Error("Markdown table cell has no consumed owner")
              const assignCell = (tokens: Token[], from = 0, end = owner.content.length) => {
                let offset = from
                for (const child of tokens) {
                  const local = markdownRawSpans(owner.content, child.raw, offset, end)
                  const spans = markdownComposeSpans(local, owner.spans)
                  origins.set(child, spans)
                  sources.set(child, { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length })
                  if (row === 0) headers.add(child)
                  if ("tokens" in child && Array.isArray(child.tokens))
                    assignCell(child.tokens, local[0].source, local.at(-1)!.source + local.at(-1)!.length)
                  offset = local.at(-1)!.source + local.at(-1)!.length
                }
              }
              assignCell(cell.tokens)
            })
          }
          rowOffset += lines[row].length + 1
        }
      }
      if (token.type === "list") assign(token.items, source)
      offset = source.end
    }
  }
  const plain = (raw: string, range: MarkdownSourceRange): Tokens.HTML[] => {
    const whole = markdownRawSpans(prepared.markdown, raw, range.start, range.end)
    let offset = 0
    return splitText(raw).map((text) => {
      const token: Tokens.HTML = {
        type: "html",
        raw: text,
        block: true,
        pre: true,
        text: `<pre data-slot="markdown-render-fallback"><code>${escape(text)}</code></pre>`,
      }
      const spans = markdownSliceSpans(whole, offset, offset + text.length)
      const source = { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length }
      sources.set(token, source)
      generatedPlain.add(token)
      origins.set(token, spans)
      offset += text.length
      return token
    })
  }
  const expand = (token: Token): Token[] => {
    const source = sources.get(token)!
    if (token.type === "code" && (token.text.length > CHARS || token.text.split("\n", 162).length > 160)) {
      const id = `code-${Object.keys(document.codes).length}`
      document.codes[id] = token.text
      let offset = 0
      return splitText(token.text).map((text) => {
        const chunk: Tokens.HTML = {
          type: "html",
          block: true,
          pre: true,
          raw: text,
          text: `<div data-slot="markdown-code-block"><pre class="shiki" data-language="text"><code>${escape(text)}</code></pre></div>`,
        }
        codeIDs.set(chunk, id)
        const spans = markdownSliceSpans(contentOrigins.get(token)!, offset, offset + text.length)
        const range = { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length }
        sources.set(chunk, range)
        origins.set(chunk, spans)
        offset += text.length
        return chunk
      })
    }
    if (token.type === "list") {
      const list = token as Tokens.List
      if (list.items.some((item) => item.raw.length > CHARS * 2)) return plain(list.raw, source)
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
        const next = {
          ...list,
          items,
          start: typeof list.start === "number" ? list.start + start : list.start,
          raw: items.map((item) => item.raw).join(""),
        }
        sources.set(next, { start: sources.get(items[0])!.start, end: sources.get(items.at(-1)!)!.end })
        output.push(next)
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
        return plain(table.raw, source)
      const output: Tokens.Table[] = []
      const lines = table.raw.split("\n")
      let rowOffset = 0
      const rowOffsets = lines.map((line) => {
        const start = rowOffset
        rowOffset += line.length + 1
        return start
      })
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
        const next = { ...table, rows: table.rows.slice(start, index), raw: "" }
        if (start > 0) continuationTables.add(next)
        const spans = markdownSliceSpans(
          origins.get(token)!,
          start === 0 ? 0 : rowOffsets[start + 2],
          rowOffsets[index + 2] ?? token.raw.length,
        )
        sources.set(next, { start: spans[0].source, end: spans.at(-1)!.source + spans.at(-1)!.length })
        output.push(next)
      }
      return output
    }
    if (token.type === "blockquote")
      return (token as Tokens.Blockquote).tokens.flatMap(expand).map((child) => {
        const next = { ...token, tokens: [child], raw: child.raw }
        sources.set(next, sources.get(child)!)
        return next
      })
    if ((token.type === "paragraph" || token.type === "text") && token.tokens) {
      if (!admittedInline(token.tokens)) return plain(token.raw, source)
      const chunks = splitInline(token.tokens, sources, origins, contentOrigins)
      return chunks.map((tokens, index) => {
        const next = { ...token, tokens, raw: tokens.map((item) => item.raw).join("") }
        sources.set(next, {
          start: index === 0 ? source.start : sources.get(tokens[0])!.start,
          end: index === chunks.length - 1 ? source.end : sources.get(tokens.at(-1)!)!.end,
        })
        return next
      })
    }
    if (token.raw.length > CHARS * 2 && token.type !== "space") return plain(token.raw, source)
    return [token]
  }
  let repeatedHeader = false
  const rangeOf = (spans: readonly MarkdownSourceSpan[]) => ({
    start: spans[0].source,
    end: spans.at(-1)!.source + spans.at(-1)!.length,
  })
  const originalSpans = (spans: readonly MarkdownSourceSpan[]) => {
    const mapped: MarkdownSourceSpan[] = []
    for (const span of spans)
      for (let index = 0; index < span.length; index++) {
        const source = prepared.sourceOffset(span.source + index),
          offset = span.offset + index
        const previous = mapped.at(-1)
        if (previous && previous.source + previous.length === source && previous.offset + previous.length === offset)
          previous.length++
        else mapped.push({ source, offset, length: 1 })
      }
    return mapped
  }
  const bind = (html: string, run: MarkdownReadingRun, element = false) => {
    const id = reading.runs.push(run) - 1
    const attribute = `data-markdown-reading="${reading.marker}:${id}"`
    return element ? html.replace(/^(\s*<[a-zA-Z][\w:-]*)/, `$1 ${attribute}`) : `<span ${attribute}>${html}</span>`
  }
  const content = (token: Token & { text: string }, kind: "text" | "escape" | "codespan") => {
    const normalized = contentOrigins.get(token)
    if (normalized) return originalSpans(normalized)
    const range = sources.get(token)!
    const raw = origins.get(token) ?? markdownRawSpans(prepared.markdown, token.raw, range.start, range.end)
    return originalSpans(
      markdownComposeSpans(
        markdownContentSpans(token.raw, token.raw, token.text, { start: 0, end: token.raw.length }, kind),
        raw,
      ),
    )
  }
  const rendering = parser.forDocument((owner) => {
    const original = {
      text: owner.text,
      codespan: owner.codespan,
      image: owner.image,
      hr: owner.hr,
      html: owner.html,
      table: owner.table,
    }
    const renderer: RendererObject = {}
    renderer.table = function (token) {
      const previous = repeatedHeader
      repeatedHeader = continuationTables.has(token)
      try {
        return original.table.call(this, token)
      } finally {
        repeatedHeader = previous
      }
    }
    renderer.text = function (token) {
      if ("tokens" in token && token.tokens) return original.text.call(this, token)
      if (repeatedHeader && headers.has(token)) return original.text.call(this, token)
      const spans = content(token, token.type === "escape" ? "escape" : "text")
      if (token.type === "escape" || token.escaped)
        return bind(original.text.call(this, token), { source: rangeOf(spans), spans })
      if (!spans.length) return original.text.call(this, token)
      return bind(original.text.call(this, token), {
        source: rangeOf(spans),
        spans: markdownTextReadingSpans(token.text, spans),
      })
    }
    renderer.codespan = function (token) {
      if (repeatedHeader && headers.has(token)) return original.codespan.call(this, token)
      const spans = content(token, "codespan")
      return bind(original.codespan.call(this, token), { source: rangeOf(spans), spans })
    }
    renderer.image = function (token) {
      if (repeatedHeader && headers.has(token)) return original.image.call(this, token)
      const range = sources.get(token)!
      return bind(
        original.image.call(this, token),
        { source: { start: prepared.sourceOffset(range.start), end: prepared.sourceOffset(range.end) } },
        true,
      )
    }
    renderer.hr = function (token) {
      const range = sources.get(token)!
      return bind(
        original.hr.call(this, token),
        { source: { start: prepared.sourceOffset(range.start), end: prepared.sourceOffset(range.end) } },
        true,
      )
    }
    renderer.html = function (token) {
      if (repeatedHeader && headers.has(token)) return original.html.call(this, token)
      const spans = contentOrigins.get(token) ?? origins.get(token)
      const html = original.html.call(this, token)
      if (spans && (contentOrigins.has(token) || codeIDs.has(token) || generatedPlain.has(token))) {
        const mapped = originalSpans(spans)
        if (!mapped.length) {
          const range = sources.get(token)!
          return bind(
            html,
            { source: { start: prepared.sourceOffset(range.start), end: prepared.sourceOffset(range.end) } },
            true,
          )
        }
        return html.replace(
          /(<code(?:\s[^>]*)?>)([\s\S]*?)(<\/code>)/,
          (all, start, body, end) => start + bind(body, { source: rangeOf(mapped), spans: mapped }) + end,
        )
      }
      const range = sources.get(token)!
      return bind(
        html,
        { source: { start: prepared.sourceOffset(range.start), end: prepared.sourceOffset(range.end) } },
        true,
      )
    }
    return renderer
  })
  const options = { ...rendering.defaults }
  if (options.extensions?.renderers) {
    options.extensions = {
      ...options.extensions,
      renderers: Object.fromEntries(
        Object.entries(options.extensions.renderers).map(([name, render]) => [
          name,
          function (this: ThisParameterType<typeof render>, token: Token) {
            const html = render.call(this, token)
            if (typeof html !== "string" || (repeatedHeader && headers.has(token))) return html
            const range = sources.get(token)!
            return bind(
              html,
              { source: { start: prepared.sourceOffset(range.start), end: prepared.sourceOffset(range.end) } },
              true,
            )
          },
        ]),
      ),
    }
  }
  const hooks = options.hooks
  if (hooks) {
    hooks.options = options
    hooks.block = true
  }
  let tokens: Token[] = rendering.lexer(prepared.markdown, options)
  if (hooks) tokens = await hooks.processAllTokens(tokens)
  assign(tokens, { start: 0, end: prepared.markdown.length })
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
    if (options.walkTokens) await Promise.all(rendering.walkTokens(group, options.walkTokens))
    let html = rendering.parser(group, options)
    if (hooks) html = await hooks.postprocess(html)
    if (html)
      document.blocks.push({
        html,
        codeID: codeIDs.get(group[0]!),
        source: {
          start: prepared.sourceOffset(sources.get(group[0]!)!.start),
          end: prepared.sourceOffset(sources.get(group.at(-1)!)!.end),
        },
      })
    if (document.blocks.length % 16 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0))
  }
  return document
}
