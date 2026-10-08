import { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import { Marked, type Renderer, type RendererObject } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import type { BundledLanguage, Highlighter } from "shiki"
import { markGeneratedKatex, markedLatex, prepareMarkdownMath, stripGeneratedKatexMarker } from "./marked-math"
import { synergyHighlightTheme } from "./highlight-theme"

function escapeHtmlAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const mathOptions = {
  throwOnError: false,
  nonStandard: true,
}

// Provenance: https://shiki.style/guide/best-performance
// Local adaptation: reuse a lazy highlighter in the worker, loading languages within a bounded grammar budget.
export function createMarkdownParser() {
  let highlighter: Highlighter | undefined
  let grammarBytes = 0
  let highlighting: Promise<void> = Promise.resolve()
  const highlight = (code: string, lang: string) => {
    const task = highlighting.then(async () => {
      if (code.length > 4096 || code.split("\n", 162).length > 160)
        return `<pre class="shiki" data-language="text"><code>${code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre>`
      const shiki = await import("shiki")
      const language = lang && lang in shiki.bundledLanguages ? (lang as BundledLanguage) : "text"
      if (language !== "text" && !highlighter?.getLoadedLanguages().includes(language)) {
        const grammar = await shiki.bundledLanguages[language]()
        const size = JSON.stringify(grammar.default).length * 8
        if (size > 32 * 1024 * 1024)
          return `<pre class="shiki" data-language="text"><code>${code.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</code></pre>`
        if (grammarBytes + size > 32 * 1024 * 1024) {
          highlighter?.dispose()
          highlighter = undefined
          grammarBytes = 0
        }
        highlighter ??= await shiki.createHighlighter({ themes: [synergyHighlightTheme], langs: [] })
        await highlighter.loadLanguage(...grammar.default)
        grammarBytes += size
      }
      highlighter ??= await shiki.createHighlighter({ themes: [synergyHighlightTheme], langs: [] })
      const html = highlighter.codeToHtml(code, { lang: language, theme: "Synergy", tabindex: false })
      return html
        .replace("<pre", `<pre data-language="${escapeHtmlAttribute(language)}"`)
        .replace("<code>", `<code data-language="${escapeHtmlAttribute(language)}">`)
    })
    highlighting = task.then(
      () => {},
      () => {},
    )
    return task
  }
  const create = () =>
    new Marked().use(
      {
        hooks: {
          preprocess: prepareMarkdownMath,
        },
        renderer: {
          html({ text }) {
            return stripGeneratedKatexMarker(text)
          },
          image({ href, title, text }) {
            const reference = ResourceReference.parse(href)
            const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : ""
            const src =
              reference.kind === "image" || (reference.kind === "url" && /^https?:/i.test(reference.url))
                ? ` src="${escapeHtmlAttribute(reference.url)}"`
                : ""
            return `<img data-resource-reference="${escapeHtmlAttribute(href)}"${src} alt="${escapeHtmlAttribute(text)}"${titleAttr}>`
          },
          link({ href, title, tokens }) {
            const titleAttr = title ? ` title="${escapeHtmlAttribute(title)}"` : ""
            const reference = ResourceReference.parse(href)
            const target =
              reference.kind === "url" || reference.kind === "anchor"
                ? `href="${escapeHtmlAttribute(reference.kind === "url" ? reference.url : href)}"`
                : `data-resource-reference="${escapeHtmlAttribute(href)}" role="button" tabindex="0"`
            return `<a ${target}${titleAttr} target="_blank" rel="noopener noreferrer">${this.parser.parseInline(tokens)}</a>`
          },
        },
      },
      markedLatex(mathOptions),
      markGeneratedKatex(markedKatex(mathOptions)),
      markedShiki({
        container: '<div data-slot="markdown-code-block" data-language="%l">%s</div>',
        highlight,
      }),
    )
  return Object.assign(create(), {
    forDocument(configure: (owner: Renderer) => RendererObject) {
      const parser = create()
      parser.use({ renderer: configure(parser.defaults.renderer!) })
      return parser
    },
    dispose() {
      highlighter?.dispose()
      highlighter = undefined
      grammarBytes = 0
    },
  })
}
