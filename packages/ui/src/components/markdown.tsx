import { useMarked } from "../context/marked"
import {
  markdownFallbackHtml,
  isCurrentMarkdownRender,
  markdownRenderEntry,
  type MarkdownRenderEntry,
} from "./markdown-render"
import { ComponentProps, createEffect, createResource, onCleanup, splitProps } from "solid-js"
import { copyTextToClipboard, type CopyState } from "./clipboard"
import { sanitizeHtml } from "./markdown-sanitize"
import * as smd from "streaming-markdown"

type Entry = MarkdownRenderEntry

const max = 200
const cache = new Map<string, Entry>()
const copyResetDelay = 1600

function touch(key: string, value: Entry) {
  cache.delete(key)
  cache.set(key, value)

  if (cache.size <= max) return

  const first = cache.keys().next().value
  if (!first) return
  cache.delete(first)
}

function formatLanguage(language: string) {
  const normalized = language.trim().toLowerCase()
  if (!normalized || normalized === "text" || normalized === "plaintext" || normalized === "markdown") return ""
  return normalized.replaceAll(/[-_]+/g, " ")
}

function enhanceMarkdown(root: HTMLDivElement) {
  const disposers: Array<() => void> = []

  for (const table of root.querySelectorAll<HTMLTableElement>("table")) {
    const parent = table.parentElement
    if (parent?.matches('[data-slot="markdown-table-scroll"]')) continue

    const wrapper = document.createElement("div")
    wrapper.dataset.slot = "markdown-table-scroll"
    parent?.insertBefore(wrapper, table)
    wrapper.append(table)
  }

  // KaTeX formula hover + click-to-copy LaTeX source
  for (const katexEl of root.querySelectorAll<HTMLElement>(".katex-display, .katex")) {
    // Skip inner .katex inside .katex-display — already handled by the parent
    if (katexEl.classList.contains("katex") && katexEl.closest(".katex-display")) continue

    const annotation = katexEl.querySelector<HTMLElement>('annotation[encoding="application/x-tex"]')
    if (!annotation) continue
    const source = (annotation.textContent ?? "").trim()
    if (!source) continue

    katexEl.dataset.katexCopy = "true"
    katexEl.title = "Click to copy LaTeX"

    let resetTimer: number | undefined

    const handleKatexClick = async (e: MouseEvent) => {
      e.stopPropagation()
      const result = await copyTextToClipboard(source, {
        label: "Copy LaTeX",
        failureDescription: "Unable to copy the LaTeX source.",
      })
      if (!result.ok) return
      const tooltip = document.createElement("span")
      tooltip.dataset.slot = "katex-copy-tooltip"
      tooltip.textContent = "Copied!"
      // Ensure the element is positioned for the tooltip
      const prevPosition = katexEl.style.position
      if (!prevPosition || prevPosition === "static") {
        katexEl.style.position = "relative"
      }
      katexEl.appendChild(tooltip)
      window.clearTimeout(resetTimer)
      resetTimer = window.setTimeout(() => {
        tooltip.remove()
        if (!prevPosition || prevPosition === "static") {
          katexEl.style.position = prevPosition || ""
        }
      }, copyResetDelay)
    }

    katexEl.addEventListener("click", handleKatexClick)

    disposers.push(() => {
      window.clearTimeout(resetTimer)
      katexEl.removeEventListener("click", handleKatexClick)
    })
  }

  for (const block of root.querySelectorAll<HTMLElement>('[data-slot="markdown-code-block"]')) {
    if (block.firstElementChild?.matches('[data-slot="markdown-code-header"]')) continue

    const pre = block.querySelector<HTMLPreElement>("pre.shiki")
    const code = pre?.querySelector<HTMLElement>("code")
    if (!pre || !code) continue

    const source = code.textContent ?? ""
    const language = pre.dataset.language || code.dataset.language || block.dataset.language || "text"
    const languageLabel = formatLanguage(language)
    const header = document.createElement("div")
    header.dataset.slot = "markdown-code-header"
    header.dataset.hasLabel = languageLabel ? "true" : "false"

    if (languageLabel) {
      const label = document.createElement("span")
      label.dataset.slot = "markdown-code-language"
      label.textContent = languageLabel
      header.append(label)
    }

    const button = document.createElement("button")
    button.type = "button"
    button.dataset.slot = "markdown-code-copy"
    button.setAttribute("aria-label", languageLabel ? `Copy ${languageLabel} code` : "Copy code")
    button.title = "Copy code"

    const text = document.createElement("span")
    text.dataset.slot = "markdown-code-copy-text"
    text.textContent = "Copy"
    button.append(text)

    header.append(button)
    block.prepend(header)

    let resetTimer: number | undefined

    const setCopyState = (state: CopyState) => {
      button.dataset.copyState = state
      button.title = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy code"
      text.textContent = state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"
    }

    setCopyState("idle")

    const handleClick = async () => {
      const result = await copyTextToClipboard(source, {
        label: "Copy code",
        failureDescription: "Unable to copy the code block.",
      })
      window.clearTimeout(resetTimer)
      setCopyState(result.ok ? "copied" : "failed")
      if (result.ok || result.reason !== "empty") {
        resetTimer = window.setTimeout(() => setCopyState("idle"), copyResetDelay)
      }
    }

    button.addEventListener("click", handleClick)

    disposers.push(() => {
      window.clearTimeout(resetTimer)
      button.removeEventListener("click", handleClick)
    })
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

export function Markdown(
  props: ComponentProps<"div"> & {
    text: string
    /**
     * When true, render incrementally with a streaming Markdown parser that
     * appends DOM nodes per chunk (#350 D5), instead of re-parsing the full text
     * through marked + shiki + katex on every delta (O(N²) main-thread cost).
     * The high-fidelity render (syntax highlight, math, sanitize + enhance) runs
     * once when this flips back to false at the end of the stream.
     */
    streaming?: boolean
    cacheKey?: string
    class?: string
    classList?: Record<string, boolean>
  },
) {
  let container!: HTMLDivElement

  const [local, others] = splitProps(props, ["text", "streaming", "cacheKey", "class", "classList"])
  const marked = useMarked()

  // Terminal (full-fidelity) HTML. Only computed when not streaming; a null
  // source short-circuits the resource so no marked work happens mid-stream.
  const [html] = createResource(
    () => (local.streaming ? null : local.text),
    async (markdown: string | null) => {
      if (markdown == null) return null
      const entry = markdownRenderEntry(markdown, "")
      const key = local.cacheKey ?? entry.hash

      if (key && entry.hash) {
        const cached = cache.get(key)
        if (cached && cached.hash === entry.hash) {
          touch(key, cached)
          return cached
        }
      }

      let next: string
      try {
        next = sanitizeHtml(await marked.parse(markdown))
      } catch {
        next = markdownFallbackHtml(markdown)
      }
      const rendered = markdownRenderEntry(markdown, next)
      if (key && rendered.hash) touch(key, rendered)
      return rendered
    },
    { initialValue: null },
  )

  // Streaming path: feed increments to the streaming-markdown parser, which
  // appends DOM into the container. Text from the typewriter is append-only in
  // the common case; if it is rewritten (not a prefix), reset the parser.
  let stream: { parser: smd.Parser; written: string } | undefined
  const resetStream = () => {
    container.innerHTML = ""
    stream = { parser: smd.parser(smd.default_renderer(container)), written: "" }
  }
  const endStream = () => {
    if (!stream) return
    try {
      smd.parser_end(stream.parser)
    } catch {
      /* ignore */
    }
    stream = undefined
  }

  createEffect(() => {
    if (!local.streaming) return
    const text = local.text
    if (!stream || !text.startsWith(stream.written)) resetStream()
    const suffix = text.slice(stream!.written.length)
    if (suffix) {
      smd.parser_write(stream!.parser, suffix)
      stream!.written = text
    }
  })

  // Terminal render: once the full-fidelity HTML resolves (and we are no longer
  // streaming), finish any live parser and replace the streamed DOM in one shot,
  // then run the one-time DOM enhancement (copy buttons, table wrap, katex copy).
  createEffect(() => {
    if (local.streaming) return
    const rendered = html()
    if (!rendered || !isCurrentMarkdownRender(rendered, local.text)) return
    endStream()
    container.innerHTML = rendered.html
    const cleanup = enhanceMarkdown(container)
    onCleanup(cleanup)
  })

  onCleanup(endStream)

  return (
    <div
      data-component="markdown"
      ref={container}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      {...others}
    />
  )
}
