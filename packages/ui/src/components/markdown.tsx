import type { MessageDescriptor } from "@lingui/core"
import { useLingui } from "@lingui/solid"
import { CODE_COPY_DESC } from "./tool-title-descriptors"
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
import { createMarkdownStreamController, type MarkdownStreamController } from "./markdown-stream"
import { createMarkdownTerminalTransitionController } from "./markdown-terminal-transition"

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

function enhanceMarkdown(root: HTMLDivElement, _: (d: MessageDescriptor) => string) {
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
    katexEl.title = _(CODE_COPY_DESC.copyLaTeX)

    let resetTimer: number | undefined

    const handleKatexClick = async (e: MouseEvent) => {
      e.stopPropagation()
      const result = await copyTextToClipboard(source, {
        label: _(CODE_COPY_DESC.copyLaTeX),
        failureDescription: _(CODE_COPY_DESC.copyLaTeXFail),
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
    button.setAttribute("aria-label", languageLabel ? `Copy ${languageLabel} code` : _(CODE_COPY_DESC.copyCode))
    button.title = _(CODE_COPY_DESC.copyCode)

    const text = document.createElement("span")
    text.dataset.slot = "markdown-code-copy-text"
    text.textContent = _(CODE_COPY_DESC.copy)
    button.append(text)

    header.append(button)
    block.prepend(header)

    let resetTimer: number | undefined

    const setCopyState = (state: CopyState) => {
      button.dataset.copyState = state
      button.title =
        state === "copied"
          ? _(CODE_COPY_DESC.copied)
          : state === "failed"
            ? _(CODE_COPY_DESC.copyFailed)
            : _(CODE_COPY_DESC.copyCode)
      text.textContent =
        state === "copied"
          ? _(CODE_COPY_DESC.copied)
          : state === "failed"
            ? _(CODE_COPY_DESC.failed)
            : _(CODE_COPY_DESC.copy)
    }

    setCopyState("idle")

    const handleClick = async () => {
      const result = await copyTextToClipboard(source, {
        label: _(CODE_COPY_DESC.copyCode),
        failureDescription: _(CODE_COPY_DESC.copyCodeFail),
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
  const { _ } = useLingui()

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

  // Streaming snapshots remain authoritative for recovery, while the renderer
  // consumes only the suffix after its offset. A shorter snapshot resets the
  // append-only parser without scanning the accumulated prefix.
  let stream: MarkdownStreamController | undefined
  const terminalTransition = createMarkdownTerminalTransitionController()
  const endStream = () => {
    if (!stream) return
    stream.end()
    stream = undefined
  }

  createEffect(() => {
    if (!local.streaming) return
    terminalTransition.reset()
    if (!stream) stream = createMarkdownStreamController(container)
    stream.update(local.text, local.cacheKey)
  })

  // Terminal render: once the full-fidelity HTML resolves (and we are no longer
  // streaming), finish any live parser and crossfade from the streamed DOM into
  // the one-shot high-fidelity tree. Enhancement (copy buttons, table wrap,
  // katex copy) runs on the terminal content only once.
  createEffect(() => {
    if (local.streaming) return
    const rendered = html()
    if (!rendered || !isCurrentMarkdownRender(rendered, local.text)) return
    const hadStreamContent = Boolean(stream)
    endStream()
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches
    terminalTransition.apply({
      hash: rendered.hash,
      container,
      html: rendered.html,
      enhance: (root) => enhanceMarkdown(root as HTMLDivElement, _),
      prefersReducedMotion,
      markdownLength: local.text.length,
      hadStreamContent,
    })
  })

  onCleanup(() => {
    terminalTransition.reset()
    endStream()
  })

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
