import { characterEntities } from "character-entities"
import { decodeNumericCharacterReference } from "micromark-util-decode-numeric-character-reference"

export type MarkdownSourceRange = { start: number; end: number }
export type MarkdownSourceSpan = { source: number; offset: number; length: number }
export type MarkdownReadingSpan = MarkdownSourceSpan & { sourceLength?: number }
export type MarkdownReadingRun = { source: MarkdownSourceRange; spans?: MarkdownReadingSpan[] }
export type MarkdownTableCellSource = { content: string; range: MarkdownSourceRange; spans: MarkdownSourceSpan[] }

type Replacement = MarkdownSourceRange & { length: number }

export function markdownSourceOffsets(replacements: readonly Replacement[]) {
  const changes = replacements.map((replacement) => ({ ...replacement, outputStart: 0, delta: 0 }))
  let delta = 0
  for (const change of changes) {
    change.outputStart = change.start + delta
    delta += change.length - (change.end - change.start)
    change.delta = delta
  }
  return (offset: number) => {
    let low = 0
    let high = changes.length
    while (low < high) {
      const middle = (low + high) >>> 1
      if (changes[middle].outputStart <= offset) low = middle + 1
      else high = middle
    }
    const change = changes[low - 1]
    if (!change) return offset
    if (offset < change.outputStart + change.length) return change.start
    return offset - change.delta
  }
}

export function markdownRawRange(source: string, raw: string, from: number, end = source.length): MarkdownSourceRange {
  const spans = markdownRawSpans(source, raw, from, end)
  const first = spans[0]
  const last = spans.at(-1)
  const finish = last ? last.source + last.length : from
  return {
    start: first?.source ?? from,
    end: raw.endsWith("\n") && source[finish - 1] === "\r" && source[finish] === "\n" ? finish + 1 : finish,
  }
}

function appendSpan(spans: MarkdownSourceSpan[], source: number, offset: number, length: number) {
  if (!length) return
  const previous = spans.at(-1)
  if (previous && previous.source + previous.length === source && previous.offset + previous.length === offset)
    previous.length += length
  else spans.push({ source, offset, length })
}

function spanIndex(spans: readonly MarkdownSourceSpan[], offset: number) {
  let low = 0
  let high = spans.length
  while (low < high) {
    const middle = (low + high) >>> 1
    const span = spans[middle]
    if (span.offset + span.length <= offset) low = middle + 1
    else high = middle
  }
  return low
}

function spanPoint(spans: readonly MarkdownSourceSpan[], offset: number, cursor: { index: number }) {
  while (cursor.index < spans.length && spans[cursor.index].offset + spans[cursor.index].length <= offset)
    cursor.index++
  const span = spans[cursor.index]
  if (!span || span.offset > offset) throw new Error("Markdown content has no consumed source")
  return span.source + offset - span.offset
}

function normalizedSource(text: string, source: number) {
  const parts: string[] = []
  const spans: MarkdownSourceSpan[] = []
  let start = 0
  let offset = 0
  for (const match of text.matchAll(/\r\n|\r|\t/g)) {
    const index = match.index
    parts.push(text.slice(start, index))
    appendSpan(spans, source + start, offset, index - start)
    offset += index - start
    const next = match[0] === "\t" ? "    " : "\n"
    parts.push(next)
    for (let index = 0; index < next.length; index++) appendSpan(spans, source + match.index, offset++, 1)
    start = match.index + match[0].length
  }
  parts.push(text.slice(start))
  appendSpan(spans, source + start, offset, text.length - start)
  return { text: parts.join(""), spans }
}

export function markdownRawSpans(source: string, raw: string, from: number, end = source.length): MarkdownSourceSpan[] {
  if (!raw.length) return []
  if (from + raw.length <= end && source.startsWith(raw, from)) return [{ source: from, offset: 0, length: raw.length }]
  const local = source.slice(from, end)
  const exact = local.indexOf(raw)
  if (exact >= 0) return [{ source: from + exact, offset: 0, length: raw.length }]
  const owner = normalizedSource(local, from)
  const token = normalizedSource(raw, 0)
  const matched: MarkdownSourceSpan[] = []
  const ownerCursor = { index: 0 }
  const capture = (sourceStart: number, offset: number, length: number) => {
    for (let index = 0; index < length; index++)
      appendSpan(matched, spanPoint(owner.spans, sourceStart + index, ownerCursor), offset + index, 1)
  }
  const exactNormalized = owner.text.indexOf(token.text)
  if (exactNormalized >= 0) capture(exactNormalized, 0, token.text.length)
  else {
    let cursor = 0
    let offset = 0
    for (const line of token.text.split("\n")) {
      const found = owner.text.indexOf(line, cursor)
      if (found < 0) throw new Error("Markdown token has no source range")
      capture(found, offset, line.length)
      offset += line.length
      cursor = found + line.length
      if (offset === token.text.length) break
      const newline = owner.text.indexOf("\n", cursor)
      if (newline < 0) throw new Error("Markdown token has no consumed newline")
      capture(newline, offset++, 1)
      cursor = newline + 1
    }
  }
  const spans: MarkdownSourceSpan[] = []
  const matchedCursor = { index: 0 }
  let previous = -1
  for (const span of token.spans)
    for (let index = 0; index < span.length; index++) {
      const offset = span.source + index
      if (offset === previous) continue
      appendSpan(spans, spanPoint(matched, span.offset + index, matchedCursor), offset, 1)
      previous = offset
    }
  return spans
}

function selectedSpans(spans: readonly MarkdownSourceSpan[], ranges: readonly MarkdownSourceRange[]) {
  const output: MarkdownSourceSpan[] = []
  let cursor = spanIndex(spans, ranges[0]?.start ?? 0)
  let offset = 0
  for (const range of ranges) {
    while (cursor < spans.length && spans[cursor].offset + spans[cursor].length <= range.start) cursor++
    let index = cursor
    while (index < spans.length && spans[index].offset < range.end) {
      const span = spans[index]
      const start = Math.max(range.start, span.offset)
      const end = Math.min(range.end, span.offset + span.length)
      appendSpan(output, span.source + start - span.offset, offset + start - range.start, end - start)
      index++
    }
    offset += range.end - range.start
  }
  return output
}

export function markdownSliceSpans(spans: readonly MarkdownSourceSpan[], start: number, end: number) {
  return selectedSpans(spans, [{ start, end }])
}

function codeRanges(raw: string): MarkdownSourceRange[] {
  // Provenance: https://github.com/markedjs/marked/blob/v17.0.1/src/Tokenizer.ts
  // Local adaptation: preserve consumed offsets through the owning lexer's code normalization.
  const fence =
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}\1[~`]* *(?=\n|$)|$)/.exec(
      raw,
    )
  const start = fence ? raw.indexOf("\n") + 1 : 0
  let end = fence ? start + (fence[3]?.length ?? 0) : raw.length
  if (!fence) while (raw[end - 1] === "\n") end--
  const indent = fence ? (/^(\s+)(?:```)/.exec(raw)?.[1].length ?? 0) : undefined
  const ranges: MarkdownSourceRange[] = []
  for (let line = start; line < end; ) {
    const newline = raw.indexOf("\n", line)
    const finish = newline < 0 ? end : Math.min(end, newline + 1)
    const text = raw.slice(line, finish)
    const removed =
      indent === undefined
        ? (/^(?: {1,4}| {0,3}\t)/.exec(text)?.[0].length ?? 0)
        : (/^[^\S\n]+/.exec(text)?.[0].length ?? 0) >= indent
          ? indent
          : 0
    ranges.push({ start: line + removed, end: finish })
    line = finish
  }
  return ranges
}

export function markdownContentSpans(
  source: string,
  raw: string,
  content: string,
  range: MarkdownSourceRange,
  kind: "text" | "escape" | "codespan" | "code",
  sourceOffset?: (offset: number) => number,
): MarkdownSourceSpan[] {
  const spans = markdownRawSpans(source, raw, range.start, range.end)
  let ranges: MarkdownSourceRange[] = [{ start: 0, end: raw.length }]
  if (kind === "escape") ranges = [{ start: 1, end: raw.length }]
  if (kind === "codespan") {
    const delimiter = /^`+/.exec(raw)?.[0].length
    if (!delimiter) throw new Error("Markdown code span has no consumed delimiter")
    let start = delimiter
    let end = raw.length - delimiter
    const normalized = raw.slice(start, end).replaceAll("\n", " ")
    if (normalized.startsWith(" ") && normalized.endsWith(" ") && /[^ ]/.test(normalized)) {
      start++
      end--
    }
    ranges = [{ start, end }]
  }
  if (kind === "code" && content !== raw) ranges = codeRanges(raw)
  const selected = ranges.map(({ start, end }) => raw.slice(start, end)).join("")
  if ((kind === "codespan" ? selected.replaceAll("\n", " ") : selected) !== content)
    throw new Error("Markdown content differs from its lexical normalization")
  const output = selectedSpans(spans, ranges)
  if (!sourceOffset) return output
  const original: MarkdownSourceSpan[] = []
  for (const span of output)
    for (let index = 0; index < span.length; index++)
      appendSpan(original, sourceOffset(span.source + index), span.offset + index, 1)
  return original
}

export function markdownComposeSpans(
  child: readonly MarkdownSourceSpan[],
  parent: readonly MarkdownSourceSpan[],
): MarkdownSourceSpan[] {
  const output: MarkdownSourceSpan[] = []
  const cursor = { index: spanIndex(parent, child[0]?.source ?? 0) }
  for (const span of child)
    for (let index = 0; index < span.length; index++)
      appendSpan(output, spanPoint(parent, span.source + index, cursor), span.offset + index, 1)
  return output
}

export function markdownTextReadingSpans(content: string, spans: readonly MarkdownSourceSpan[]): MarkdownReadingSpan[] {
  const output: MarkdownReadingSpan[] = []
  let start = 0
  let offset = 0
  const literal = (end: number) => {
    for (const span of markdownSliceSpans(spans, start, end))
      appendSpan(output, span.source, offset + span.offset, span.length)
    offset += end - start
  }
  // Provenance: https://github.com/micromark/micromark/tree/main/packages/micromark-util-decode-numeric-character-reference
  // Named references: https://github.com/wooorm/character-entities
  // Local adaptation: normalize complete references without DOM dependencies; lexical escapes and code remain literal.
  for (const match of content.matchAll(/&(?:#(?:\d{1,7}|[xX][\da-fA-F]{1,6})|\w+);/g)) {
    const name = match[0].slice(1, -1)
    const hexadecimal = name[1] === "x" || name[1] === "X"
    const decoded =
      name[0] === "#"
        ? decodeNumericCharacterReference(name.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10)
        : Object.hasOwn(characterEntities, name)
          ? characterEntities[name]
          : match[0]
    if (decoded === match[0]) continue
    literal(match.index)
    const cursor = { index: spanIndex(spans, match.index) }
    const source = spanPoint(spans, match.index, cursor)
    const sourceEnd = spanPoint(spans, match.index + match[0].length - 1, cursor) + 1
    output.push({ source, offset, length: decoded.length, sourceLength: sourceEnd - source })
    offset += decoded.length
    start = match.index + match[0].length
  }
  literal(content.length)
  return output
}

export function markdownTableCells(source: string, from: number, end = source.length): MarkdownTableCellSource[] {
  const separators: number[] = []
  let slashes = 0
  for (let index = from; index < end; index++) {
    if (source[index] === "|" && slashes % 2 === 0) separators.push(index)
    slashes = source[index] === "\\" ? slashes + 1 : 0
  }
  const boundaries = [from - 1, ...separators, end]
  const ranges = boundaries.slice(0, -1).map((separator, index) => {
    let start = separator + 1
    let finish = boundaries[index + 1]
    while (start < finish && /\s/.test(source[start])) start++
    while (finish > start && /\s/.test(source[finish - 1])) finish--
    return { start, end: finish }
  })
  if (separators[0] !== undefined && ranges[0].start === ranges[0].end) ranges.shift()
  if (separators.at(-1) !== undefined && ranges.at(-1)?.start === ranges.at(-1)?.end) ranges.pop()
  return ranges.map((range) => {
    const raw = source.slice(range.start, range.end)
    const spans: MarkdownSourceSpan[] = []
    const parts: string[] = []
    let start = 0
    let offset = 0
    for (const match of raw.matchAll(/\\\|/g)) {
      parts.push(raw.slice(start, match.index), "|")
      appendSpan(spans, range.start + start, offset, match.index - start)
      offset += match.index - start
      appendSpan(spans, range.start + match.index + 1, offset++, 1)
      start = match.index + 2
    }
    parts.push(raw.slice(start))
    appendSpan(spans, range.start + start, offset, raw.length - start)
    return { content: parts.join(""), range, spans }
  })
}
