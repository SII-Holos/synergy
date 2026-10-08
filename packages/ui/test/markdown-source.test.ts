import { expect, test } from "bun:test"
import { Marked, type Tokens } from "marked"
import {
  markdownComposeSpans,
  markdownContentSpans,
  markdownRawRange,
  markdownRawSpans,
  markdownSliceSpans,
  markdownTableCells,
  markdownTextReadingSpans,
  type MarkdownSourceSpan,
} from "../src/context/markdown-source"

function points(spans: readonly MarkdownSourceSpan[], length: number) {
  return Array.from({ length }, (_, offset) => {
    const span = spans.find((span) => span.offset <= offset && offset < span.offset + span.length)
    return span ? span.source + offset - span.offset : undefined
  })
}

test("a consumed raw token keeps compact original UTF16 provenance", () => {
  const source = "unrelated prefix\n👩‍🔬 continuous text\nignored suffix"
  const raw = "👩‍🔬 continuous text"
  const from = source.indexOf(raw)
  expect(markdownRawSpans(source, raw, from, from + raw.length)).toEqual([
    { source: from, offset: 0, length: raw.length },
  ])
})

test("quote prefixes, tab expansion and CRLF retain the consumed glyph source", () => {
  const source = "> first\r\n> \tsecond\r\n"
  const raw = "first\n    second\n"
  const expected = [
    ...Array.from({ length: 5 }, (_, index) => 2 + index),
    source.indexOf("\r"),
    ...Array.from({ length: 4 }, () => source.indexOf("\t")),
    ...Array.from({ length: 6 }, (_, index) => source.indexOf("second") + index),
    source.lastIndexOf("\r"),
  ]
  expect(points(markdownRawSpans(source, raw, 0, source.length), raw.length)).toEqual(expected)
})

test("blank consumed lines retain their own newline across removed list prefixes", () => {
  const source = "- first\r\n\r\n  second\r\n"
  const raw = "first\n\nsecond\n"
  const expected = [
    ...Array.from({ length: 5 }, (_, index) => 2 + index),
    7,
    9,
    ...Array.from({ length: 6 }, (_, index) => 13 + index),
    19,
  ]
  expect(points(markdownRawSpans(source, raw, 0, source.length), raw.length)).toEqual(expected)
})

test("a token cannot borrow an identical label beyond its consumed owner", () => {
  const source = "outside target\nowner missing\ntarget"
  expect(() => markdownRawSpans(source, "target", source.indexOf("owner"), source.lastIndexOf("target"))).toThrow()
})

test.each([
  ["` a\nb `", "a b", 2],
  ["``  a\nb  ``", " a b ", 3],
  ["`   `", "   ", 1],
])("code span normalization maps only its consumed content: %s", (raw, content, from) => {
  const source = "prefix " + raw + " suffix"
  const range = { start: 7, end: 7 + raw.length }
  expect(points(markdownContentSpans(source, raw, content, range, "codespan"), content.length)).toEqual(
    Array.from({ length: content.length }, (_, index) => 7 + from + index),
  )
})

test("escape mapping removes syntax while retaining the source character", () => {
  expect(markdownContentSpans("before \\* after", "\\*", "*", { start: 7, end: 9 }, "escape")).toEqual([
    { source: 8, offset: 0, length: 1 },
  ])
})

test.each([
  "```txt\n\n\n  target\n```\n",
  "  ```txt\n  first\n    second\n  ```\n",
  "  ```txt\n \n  second\n  ```\n",
  "  ~~~txt\n  first\n  ~~~\n",
  "    first\n\n    second\n",
  "\tfirst\n \tsecond\n",
])("block code normalization follows the real lexer: %s", (source) => {
  const token = new Marked().lexer(source).find((token) => token.type === "code")
  if (!token || token.type !== "code") throw new Error("Expected code token")
  const spans = markdownContentSpans(source, token.raw, token.text, { start: 0, end: token.raw.length }, "code")
  const actual = points(spans, token.text.length)
  for (let index = 0; index < token.text.length; index++) {
    expect(actual[index]).toBeDefined()
    expect(source[actual[index]!]).toBe(token.text[index])
  }
})

test("source composition preserves original CRLF offsets without per-character runs", () => {
  const source = "first\nsecond"
  const spans = markdownContentSpans(source, source, source, { start: 0, end: source.length }, "text", (offset) =>
    offset <= 5 ? offset : offset + 1,
  )
  expect(spans).toEqual([
    { source: 0, offset: 0, length: 6 },
    { source: 7, offset: 6, length: 6 },
  ])
})

test("table cell owners exclude separators and preserve escaped-pipe consumption", () => {
  const source = "| first \\| value | final |"
  const cells = markdownTableCells(source, 0, source.length)
  expect(cells.map((cell) => cell.content)).toEqual(["first | value", "final"])
  const pipe = cells[0].content.indexOf("|")
  expect(points(cells[0].spans, cells[0].content.length)[pipe]).toBe(source.indexOf("\\|") + 1)
  expect(cells.every((cell) => cell.range.start < cell.range.end)).toBe(true)
})

test("table token provenance composes from its consumed cell into original row UTF16", () => {
  const source = "| **left** \\| right | tail |"
  const cell = markdownTableCells(source, 0, source.length)[0]
  const literal = " | right"
  const child = markdownRawSpans(cell.content, literal, 0, cell.content.length)
  const actual = points(markdownComposeSpans(child, cell.spans), literal.length)
  expect(actual).toEqual([10, 12, 13, 14, 15, 16, 17, 18])
})

test("raw consumption includes the complete original CRLF", () => {
  const source = "> first\r\n"
  expect(markdownRawRange(source, "first\n", 0, source.length)).toEqual({ start: 2, end: source.length })
})

test("normalized code provenance is sliced once into later chunks without reinterpreting delimiters", () => {
  const content = "x".repeat(8190) + " \n" + "👩‍🔬 target"
  const raw = "`` " + content + " ``"
  const normalized = content.replaceAll("\n", " ")
  const spans = markdownContentSpans(raw, raw, normalized, { start: 0, end: raw.length }, "codespan")
  const later = markdownSliceSpans(spans, 8192, normalized.length)
  expect(points(later, normalized.length - 8192)).toEqual(
    Array.from({ length: normalized.length - 8192 }, (_, index) => 8195 + index),
  )
  expect(later).toHaveLength(1)
})

test.each([
  "| first \\| value | tail |",
  "first \\| value | tail",
  "| first " + "\\".repeat(2) + " | tail |",
  "| first " + "\\".repeat(3) + "| value | tail |",
  "| | tail |",
])("table consumption follows the real lexer for escaped separators: %s", (row) => {
  const markdown = "| Head | Two |\n|---|---|\n" + row + "\n"
  const token = new Marked().lexer(markdown).find((token) => token.type === "table")
  if (!token || token.type !== "table") throw new Error("Expected table token")
  const from = markdown.indexOf(row)
  const cells = markdownTableCells(markdown, from, from + row.length)
  expect(cells.map((cell) => cell.content)).toEqual((token as Tokens.Table).rows[0].map((cell) => cell.text))
  for (const cell of cells) {
    const actual = points(cell.spans, cell.content.length)
    expect(
      actual.every((offset) => offset !== undefined && cell.range.start <= offset && offset < cell.range.end),
    ).toBe(true)
  }
})

test("long literal leaves keep one affine run and never map an earlier source prefix", () => {
  const prefix = "discarded prefix ".repeat(100_000)
  const raw = "accepted ".repeat(100_000)
  const source = prefix + raw + "excluded tail"
  let calls = 0
  let lowest = source.length
  const spans = markdownContentSpans(
    source,
    raw,
    raw,
    { start: prefix.length, end: prefix.length + raw.length },
    "text",
    (offset) => {
      lowest = Math.min(lowest, offset)
      calls++
      return offset
    },
  )
  expect(spans).toEqual([{ source: prefix.length, offset: 0, length: raw.length }])
  expect(lowest).toBe(prefix.length)
  expect(calls).toBe(raw.length)
})

test("slicing and composing a later run do not walk the accepted prefix again", () => {
  const spans = Array.from({ length: 10_000 }, (_, index) => ({ source: index * 3, offset: index * 2, length: 2 }))
  let reads = 0
  const observed = new Proxy(spans, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  expect(markdownComposeSpans([{ source: 19_998, offset: 0, length: 2 }], observed)).toEqual([
    { source: 29_997, offset: 0, length: 2 },
  ])
  expect(reads).toBeLessThan(80)
  reads = 0
  expect(markdownSliceSpans(observed, 19_998, 20_000)).toEqual([{ source: 29_997, offset: 0, length: 2 }])
  expect(reads).toBeLessThan(80)
})

test("text character references describe collapsed source ranges and decoded UTF16 positions", () => {
  const content = "&amp; middle &#x1F469;"
  expect(markdownTextReadingSpans(content, [{ source: 10, offset: 0, length: content.length }])).toEqual([
    { source: 10, offset: 0, length: 1, sourceLength: 5 },
    { source: 15, offset: 1, length: 8 },
    { source: 23, offset: 9, length: 2, sourceLength: 9 },
  ])
})

test.each([
  ["&#65;", 1],
  ["&#128;", 1],
  ["&#0;", 1],
  ["&#x110000;", 1],
  ["&NotEqualTilde;", 2],
  ["&CounterClockwiseContourIntegral;", 1],
])("HTML character reference normalization is bounded to its consumed token: %s", (content, length) => {
  expect(markdownTextReadingSpans(content, [{ source: 17, offset: 0, length: content.length }])).toEqual([
    { source: 17, offset: 0, length, sourceLength: content.length },
  ])
})

test("unknown references and ordinary escapes remain one literal provenance run", () => {
  const content = "before &unknown; &amp without semicolon \\* after"
  expect(markdownTextReadingSpans(content, [{ source: 0, offset: 0, length: content.length }])).toEqual([
    { source: 0, offset: 0, length: content.length },
  ])
})

test("text reference normalization composes after original CRLF source mapping", () => {
  const source = "first\n&amp; tail"
  const spans = markdownContentSpans(source, source, source, { start: 0, end: source.length }, "text", (offset) =>
    offset <= 5 ? offset : offset + 1,
  )
  expect(markdownTextReadingSpans(source, spans)).toEqual([
    { source: 0, offset: 0, length: 6 },
    { source: 7, offset: 6, length: 1, sourceLength: 5 },
    { source: 12, offset: 7, length: 5 },
  ])
})
