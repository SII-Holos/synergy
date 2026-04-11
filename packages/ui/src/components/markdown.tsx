import { useMarked } from "../context/marked"
import { checksum } from "@ericsanchezok/synergy-util/encode"
import { ComponentProps, createEffect, createResource, onCleanup, splitProps } from "solid-js"

type Entry = {
  hash: string
  html: string
}

const max = 200
const cache = new Map<string, Entry>()
const copyResetDelay = 2000

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

    const setCopied = (copied: boolean) => {
      button.dataset.copied = copied ? "true" : "false"
      button.title = copied ? "Copied" : "Copy code"
      text.textContent = copied ? "Copied" : "Copy"
    }

    setCopied(false)

    const handleClick = async () => {
      try {
        await navigator.clipboard.writeText(source)
        window.clearTimeout(resetTimer)
        setCopied(true)
        resetTimer = window.setTimeout(() => setCopied(false), copyResetDelay)
      } catch {
        setCopied(false)
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
    cacheKey?: string
    class?: string
    classList?: Record<string, boolean>
  },
) {
  let container!: HTMLDivElement

  const [local, others] = splitProps(props, ["text", "cacheKey", "class", "classList"])
  const marked = useMarked()
  const [html] = createResource(
    () => local.text,
    async (markdown) => {
      const hash = checksum(markdown)
      const key = local.cacheKey ?? hash

      if (key && hash) {
        const cached = cache.get(key)
        if (cached && cached.hash === hash) {
          touch(key, cached)
          return cached.html
        }
      }

      const next = await marked.parse(markdown)
      if (key && hash) touch(key, { hash, html: next })
      return next
    },
    { initialValue: "" },
  )

  createEffect(() => {
    html.latest
    const cleanup = enhanceMarkdown(container)
    onCleanup(cleanup)
  })

  return (
    <div
      data-component="markdown"
      ref={container}
      classList={{
        ...(local.classList ?? {}),
        [local.class ?? ""]: !!local.class,
      }}
      innerHTML={html.latest}
      {...others}
    />
  )
}
