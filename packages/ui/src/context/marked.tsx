import { marked } from "marked"
import markedKatex from "marked-katex-extension"
import markedShiki from "marked-shiki"
import type { BundledLanguage } from "shiki"
import { createSimpleContext } from "./helper"
import { markGeneratedKatex, markedLatex, prepareMarkdownMath, stripGeneratedKatexMarker } from "./marked-math"
import type { ThemeRegistrationResolved } from "@pierre/diffs"

export const synergyHighlightTheme = {
  name: "Synergy",
  colors: {
    "editor.background": "transparent",
    "editor.foreground": "var(--text-base)",
    "gitDecoration.addedResourceForeground": "var(--syntax-diff-add)",
    "gitDecoration.deletedResourceForeground": "var(--syntax-diff-delete)",
  },
  tokenColors: [
    {
      scope: ["comment", "punctuation.definition.comment", "string.comment"],
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: ["entity.other.attribute-name"],
      settings: {
        foreground: "var(--syntax-property)", // maybe attribute
      },
    },
    {
      scope: ["constant", "entity.name.constant", "variable.other.constant", "variable.language"],
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: [
        "entity.name.type",
        "entity.name.class",
        "entity.name.namespace",
        "entity.name.interface",
        "entity.name.struct",
        "entity.name.enum",
        "entity.name.type.alias",
        "entity.name.trait",
        "support.class.component",
      ],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: ["meta.object.member", "support.type.object.module", "variable.other.object"],
      settings: {
        foreground: "var(--syntax-object)",
      },
    },
    {
      scope: ["variable.parameter.function", "meta.definition.variable"],
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: [
        "meta.embedded.expression",
        "meta.template.expression",
        "string.other.begin.yaml",
        "string.other.end.yaml",
      ],
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["entity.name.function", "support.function", "support.function.builtin"],
      settings: {
        foreground: "var(--syntax-property)",
      },
    },
    {
      scope: ["support.type", "support.type.primitive"],
      settings: {
        foreground: "var(--syntax-type)",
      },
    },
    {
      scope: "keyword",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "keyword.operator",
        "storage.type.function.arrow",
        "punctuation.separator.key-value.css",
        "entity.name.tag.yaml",
        "punctuation.separator.key-value.mapping.yaml",
      ],
      settings: {
        foreground: "var(--syntax-operator)",
      },
    },
    {
      scope: ["storage", "storage.type"],
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: ["storage.modifier.package", "storage.modifier.import", "storage.type.java"],
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "string",
        "punctuation.definition.string",
        "string punctuation.section.embedded source",
        "entity.name.tag",
      ],
      settings: {
        foreground: "var(--syntax-string)",
      },
    },
    {
      scope: ["support", "support.constant"],
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: ["support.type.property-name.css", "meta.property-name", "variable.other.property"],
      settings: {
        foreground: "var(--syntax-property)",
      },
    },
    {
      scope: "variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "variable.other",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: [
        "invalid.broken",
        "invalid.illegal",
        "invalid.unimplemented",
        "invalid.deprecated",
        "message.error",
        "markup.deleted",
        "meta.diff.header.from-file",
        "punctuation.definition.deleted",
        "brackethighlighter.unmatched",
        "token.error-token",
      ],
      settings: {
        foreground: "var(--syntax-critical)",
      },
    },
    {
      scope: "carriage-return",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: "string source",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: "string variable",
      settings: {
        foreground: "var(--syntax-constant)",
      },
    },
    {
      scope: [
        "source.regexp",
        "string.regexp",
        "string.regexp.character-class",
        "string.regexp constant.character.escape",
        "string.regexp source.ruby.embedded",
        "string.regexp string.regexp.arbitrary-repitition",
        "string.regexp constant.character.escape",
      ],
      settings: {
        foreground: "var(--syntax-regexp)",
      },
    },
    {
      scope: "support.variable",
      settings: {
        foreground: "var(--syntax-variable)",
      },
    },
    {
      scope: ["meta.module-reference", "entity.name.module"],
      settings: {
        foreground: "var(--syntax-object)",
      },
    },
    {
      scope: "punctuation.definition.list.begin.markdown",
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["markup.heading", "markup.heading entity.name"],
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.quote",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "markup.italic",
      settings: {
        fontStyle: "italic",
        // foreground: "",
      },
    },
    {
      scope: "markup.bold",
      settings: {
        fontStyle: "bold",
        foreground: "var(--text-strong)",
      },
    },
    {
      scope: [
        "markup.raw",
        "markup.inserted",
        "meta.diff.header.to-file",
        "punctuation.definition.inserted",
        "markup.changed",
        "punctuation.definition.changed",
        "markup.ignored",
        "markup.untracked",
      ],
      settings: {
        foreground: "var(--text-base)",
      },
    },
    {
      scope: "meta.diff.range",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "meta.diff.header",
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: "meta.separator",
      settings: {
        fontStyle: "bold",
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: "meta.output",
      settings: {
        foreground: "var(--syntax-comment)",
      },
    },
    {
      scope: "meta.export.default",
      settings: {
        foreground: "var(--syntax-keyword)",
      },
    },
    {
      scope: [
        "brackethighlighter.tag",
        "brackethighlighter.curly",
        "brackethighlighter.round",
        "brackethighlighter.square",
        "brackethighlighter.angle",
        "brackethighlighter.quote",
      ],
      settings: {
        foreground: "var(--syntax-punctuation)",
      },
    },
    {
      scope: ["constant.other.reference.link", "string.other.link"],
      settings: {
        fontStyle: "underline",
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "token.info-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
    {
      scope: "token.warn-token",
      settings: {
        foreground: "var(--syntax-warning)",
      },
    },
    {
      scope: "token.debug-token",
      settings: {
        foreground: "var(--syntax-info)",
      },
    },
  ],
  semanticTokenColors: {
    comment: "var(--syntax-comment)",
    string: "var(--syntax-string)",
    number: "var(--syntax-constant)",
    regexp: "var(--syntax-regexp)",
    keyword: "var(--syntax-keyword)",
    variable: "var(--syntax-variable)",
    parameter: "var(--syntax-variable)",
    property: "var(--syntax-property)",
    function: "var(--syntax-property)",
    method: "var(--syntax-property)",
    type: "var(--syntax-type)",
    class: "var(--syntax-type)",
    namespace: "var(--syntax-type)",
    enumMember: "var(--syntax-constant)",
    "variable.constant": "var(--syntax-constant)",
    "variable.defaultLibrary": "var(--syntax-object)",
  },
} as unknown as ThemeRegistrationResolved

let highlightThemePromise: Promise<typeof import("@pierre/diffs")> | undefined

export function ensureSynergyHighlightTheme() {
  if (highlightThemePromise) return highlightThemePromise
  highlightThemePromise = import("@pierre/diffs").then((pierre) => {
    pierre.registerCustomTheme("Synergy", () => Promise.resolve(synergyHighlightTheme))
    return pierre
  })
  return highlightThemePromise
}

let highlightRuntimePromise:
  | Promise<[Awaited<ReturnType<typeof ensureSynergyHighlightTheme>>, typeof import("shiki")]>
  | undefined

function loadHighlightRuntime() {
  highlightRuntimePromise ??= Promise.all([ensureSynergyHighlightTheme(), import("shiki")])
  return highlightRuntimePromise
}

function escapeHtmlAttribute(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
}

const mathOptions = {
  throwOnError: false,
  nonStandard: true,
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () => {
    return marked.use(
      {
        hooks: {
          preprocess: prepareMarkdownMath,
        },
        renderer: {
          html({ text }) {
            return stripGeneratedKatexMarker(text)
          },
          link({ href, title, text }) {
            const titleAttr = title ? ` title="${title}"` : ""
            return `<a href="${href}"${titleAttr} target="_blank" rel="noopener noreferrer">${text}</a>`
          },
        },
      },
      markedLatex(mathOptions),
      markGeneratedKatex(markedKatex(mathOptions)),
      markedShiki({
        container: '<div data-slot="markdown-code-block" data-language="%l">%s</div>',
        async highlight(code, lang) {
          const [pierre, shiki] = await loadHighlightRuntime()
          const { bundledLanguages } = shiki
          const highlighter = await pierre.getSharedHighlighter({ themes: ["Synergy"], langs: [] })
          const language = lang && lang in bundledLanguages ? lang : "text"
          if (!highlighter.getLoadedLanguages().includes(language)) {
            await highlighter.loadLanguage(language as BundledLanguage)
          }
          const html = await highlighter.codeToHtml(code, {
            lang: language,
            theme: "Synergy",
            tabindex: false,
          })
          return html
            .replace("<pre", `<pre data-language="${escapeHtmlAttribute(language)}"`)
            .replace("<code>", `<code data-language="${escapeHtmlAttribute(language)}">`)
        },
      }),
    )
  },
})
