import katex from "katex"
import type { MarkedExtension, TokenizerAndRendererExtension } from "marked"
import type { MarkedKatexOptions } from "marked-katex-extension"
import { generateUUID } from "@ericsanchezok/synergy-util/uuid"

const generatedKatexAttribute = "data-synergy-katex-generated"
const generatedKatexMarker = generateUUID()
const blockLatexRule = /^[ \t]{0,3}(\\{1,2})\[([\s\S]*?)\1\][ \t]*(?:\n|$)/
const blockLatexStartRule = /\n[ \t]{0,3}\\{1,2}\[/
const inlineDisplayLatexRule = /^(\\{1,2})\[([^\n]*?)\1\]/
const inlineLatexRule = /^(\\{1,2})\(([^\n]*?)\1\)/
const inlineLatexStartRule = /\\{1,2}[[(]/
const rawGeneratedKatexAttributeRule = new RegExp(
  `\\s${generatedKatexAttribute}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]+))?`,
  "gi",
)
const tableMathRule =
  /\\\\\[[^\n]*?\\\\\]|\\\[[^\n]*?\\\]|\\\\\([^\n]*?\\\\\)|\\\([^\n]*?\\\)|\$\$[^$\n]*\$\$|\$[^$\n]*\$/g
const fenceStartRule = /^[ \t]{0,3}(`{3,}|~{3,})/

export function prepareMarkdownMath(markdown: string) {
  return escapeTableMathPipes(markdown)
}

export function stripGeneratedKatexMarker(html: string) {
  return html.replace(rawGeneratedKatexAttributeRule, "")
}

export function isGeneratedKatex(element: Element) {
  return element.getAttribute(generatedKatexAttribute) === generatedKatexMarker
}

export function getGeneratedKatexSource(element: Element) {
  if (!isGeneratedKatex(element)) return
  const annotation = element.querySelector('annotation[encoding="application/x-tex"]')
  const source = annotation?.textContent?.trim()
  return source || undefined
}

export function markedLatex(options: MarkedKatexOptions): MarkedExtension {
  return {
    extensions: [
      {
        name: "blockLatex",
        level: "block",
        start(src) {
          const index = src.search(blockLatexStartRule)
          return index === -1 ? undefined : index
        },
        tokenizer(src) {
          const match = blockLatexRule.exec(src)
          if (!match) return
          return {
            type: "blockLatex",
            raw: match[0],
            text: match[2].trim(),
          }
        },
        renderer(token) {
          return `${renderKatex(token.text, options, true)}\n`
        },
      },
      {
        name: "inlineDisplayLatex",
        level: "inline",
        start(src) {
          const index = src.search(inlineLatexStartRule)
          return index === -1 ? undefined : index
        },
        tokenizer(src) {
          const match = inlineDisplayLatexRule.exec(src)
          if (!match) return
          return {
            type: "inlineDisplayLatex",
            raw: match[0],
            text: match[2].trim(),
          }
        },
        renderer(token) {
          return renderKatex(token.text, options, false)
        },
      },
      {
        name: "inlineLatex",
        level: "inline",
        start(src) {
          const index = src.search(inlineLatexStartRule)
          return index === -1 ? undefined : index
        },
        tokenizer(src) {
          const match = inlineLatexRule.exec(src)
          if (!match) return
          return {
            type: "inlineLatex",
            raw: match[0],
            text: match[2].trim(),
          }
        },
        renderer(token) {
          return renderKatex(token.text, options, false)
        },
      },
    ],
  }
}

export function markGeneratedKatex(extension: MarkedExtension): MarkedExtension {
  return {
    ...extension,
    extensions: extension.extensions?.map(wrapKatexRenderer),
  }
}

function escapeTableMathPipes(text: string) {
  const lines = text.split("\n")
  let fence: { marker: string; length: number } | undefined
  let inTable = false

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const fenceMatch = fenceStartRule.exec(line)

    if (fence) {
      if (fenceMatch?.[1]?.startsWith(fence.marker) && fenceMatch[1].length >= fence.length) fence = undefined
      continue
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1][0], length: fenceMatch[1].length }
      inTable = false
      continue
    }
    if (/^(?: {4}|\t)/.test(line)) {
      inTable = false
      continue
    }

    const trimmed = line.trim()
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      inTable = true
    } else if (inTable && !trimmed.startsWith("|")) {
      inTable = false
    }

    if (!inTable) continue
    lines[i] = line.replace(tableMathRule, (math) => math.replaceAll("|", "\\vert "))
  }

  return lines.join("\n")
}

function renderKatex(text: string, options: MarkedKatexOptions, displayMode: boolean) {
  return markKatexHtml(katex.renderToString(text, { ...options, displayMode }))
}

function markKatexHtml(html: string) {
  return html.replace("<span ", `<span ${generatedKatexAttribute}="${generatedKatexMarker}" `)
}

function wrapKatexRenderer(item: TokenizerAndRendererExtension): TokenizerAndRendererExtension {
  if (!("renderer" in item) || !item.renderer) return item
  if (item.name !== "inlineKatex" && item.name !== "blockKatex") return item

  const renderer = item.renderer
  return {
    ...item,
    renderer(token) {
      const output = renderer.call(this, token)
      return typeof output === "string" ? markKatexHtml(output) : output
    },
  }
}
