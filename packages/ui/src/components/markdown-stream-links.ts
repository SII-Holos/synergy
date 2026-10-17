import { isBareUrlBoundary } from "@ericsanchezok/synergy-util/markdown-link"
import { Lexer } from "marked"
import * as smd from "streaming-markdown"

declare module "streaming-markdown" {
  function parser_write(parser: Parser, chunk: string, source: number | readonly SourceSpan[]): void
}

const literal = new Set<number>([
  smd.LINK,
  smd.IMAGE,
  smd.RAW_URL,
  smd.CODE_INLINE,
  smd.CODE_BLOCK,
  smd.CODE_FENCE,
  smd.EQUATION_BLOCK,
  smd.EQUATION_INLINE,
])

export function createMarkdownLinkStream(parser: smd.Parser) {
  let candidate: { text: string; start: number; angle: boolean } | undefined
  const emit = (text: string, start: number) => smd.parser_write(parser, text, start)
  const link = (text: string, href: string, start: number, bare: boolean) => {
    const escapedHref = href.replace(/[()]/g, (char) => (char === "(" ? "%28" : "%29"))
    let label = ""
    const spans: smd.SourceSpan[] = [{ source: -1, length: 1 }]
    for (let index = 0; index < text.length; index++) {
      const char = text[index]
      if (/[[\]\\_*~`$]/.test(char)) {
        label += "\\"
        spans.push({ source: -1, length: 1 })
      }
      label += char
      spans.push({ source: start + index, length: 1 })
    }
    spans.push({ source: -1, length: escapedHref.length + 3 })
    const before = parser.renderer.add_token
    const beforeAttr = parser.renderer.set_attr
    parser.renderer.set_attr = (data, type, value) => beforeAttr(data, type, type === smd.HREF ? href : value)
    parser.renderer.add_token = (data, type, source) => {
      before(data, type, source)
      if (type === smd.LINK && bare)
        (data as smd.Default_Renderer_Data).nodes[(data as smd.Default_Renderer_Data).index]?.setAttribute(
          "data-resource-bare",
          "true",
        )
    }
    try {
      smd.parser_write(parser, `[${label}](${escapedHref})`, spans)
    } finally {
      parser.renderer.add_token = before
      parser.renderer.set_attr = beforeAttr
    }
  }
  const finish = (closed = false) => {
    const current = candidate
    candidate = undefined
    if (!current) return
    if (current.angle) {
      const value = current.text.slice(1)
      if (closed && /^[a-z][a-z\d+.-]*:[^\s<>]+$/i.test(value)) link(value, value, current.start + 1, false)
      else emit(current.text + (closed ? ">" : ""), current.start)
      return
    }
    const token = new Lexer({ gfm: true }).inlineTokens(current.text)[0]
    if (token?.type !== "link" || !token.raw.startsWith("www.")) {
      emit(current.text, current.start)
      return
    }
    link(token.raw, token.href, current.start, true)
    emit(current.text.slice(token.raw.length), current.start + token.raw.length)
  }
  return {
    write(text: string, start: number, previous: string) {
      let from = 0
      for (let index = 0; index < text.length; index++) {
        const char = text[index]
        if (candidate) {
          if (candidate.angle ? char === ">" : /\s|[<>]/.test(char) || isBareUrlBoundary(char)) {
            const consumed = candidate.angle && char === ">"
            finish(consumed)
            from = index + (consumed ? 1 : 0)
            if (consumed) continue
          } else if (candidate.angle && /\s/.test(char)) {
            finish()
            from = index
          } else {
            candidate.text += char
            from = index + 1
            continue
          }
        }
        if (char !== "w" && char !== "<") continue
        emit(text.slice(from, index), start + from)
        from = index
        const preceding = index ? text[index - 1] : previous
        const pending = parser.pending
        if (
          literal.has(parser.token) ||
          /[\\`\[!$*_~]$/.test(pending) ||
          (char === "w" && preceding && !/[\s(]/.test(preceding) && !isBareUrlBoundary(preceding))
        )
          continue
        candidate = { text: char, start: start + index, angle: char === "<" }
        from = index + 1
      }
      if (!candidate) emit(text.slice(from), start + from)
    },
    end: () => finish(),
  }
}
