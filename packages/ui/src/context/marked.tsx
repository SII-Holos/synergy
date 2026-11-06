import { createSimpleContext } from "./helper"
import { onCleanup } from "solid-js"
import { synergyHighlightTheme } from "./highlight-theme"
import { createMarkdownParser } from "./markdown-parser"
import { createMarkdownWorkerClient } from "./markdown-worker-client"
import { parseMarkdownDocument } from "./markdown-document"
export { synergyHighlightTheme } from "./highlight-theme"

let highlightThemePromise: Promise<typeof import("@pierre/diffs")> | undefined

export function ensureSynergyHighlightTheme() {
  if (highlightThemePromise) return highlightThemePromise
  highlightThemePromise = import("@pierre/diffs").then((pierre) => {
    pierre.registerCustomTheme("Synergy", () => Promise.resolve(synergyHighlightTheme))
    return pierre
  })
  return highlightThemePromise
}

let clients = 0
let worker: ReturnType<typeof createMarkdownWorkerClient> | undefined
let local: ReturnType<typeof createMarkdownParser> | undefined

function client() {
  worker ??= createMarkdownWorkerClient(() => {
    const port = new Worker(new URL("./markdown-worker.ts", import.meta.url), { type: "module" })
    return {
      postMessage: (message) => port.postMessage(message),
      onMessage: (receive) => port.addEventListener("message", receive),
      onError: (receive) => {
        port.addEventListener("error", (event) => receive(new Error(event.message || "Markdown worker failed")))
        port.addEventListener("messageerror", () => receive(new Error("Markdown worker response could not be decoded")))
      },
      terminate: () => port.terminate(),
    }
  })
  return worker
}

export const { use: useMarked, provider: MarkedProvider } = createSimpleContext({
  name: "Marked",
  init: () => {
    clients++
    onCleanup(() => {
      if (--clients === 0) {
        worker?.dispose()
        worker = undefined
        local?.dispose()
        local = undefined
      }
    })
    return {
      async parse(markdown: string, signal?: AbortSignal) {
        if (typeof Worker === "undefined") {
          local ??= createMarkdownParser()
          return await local.parse(markdown)
        }
        return client().parse(markdown, signal)
      },
      async parseInline(markdown: string, signal?: AbortSignal) {
        if (typeof Worker === "undefined") {
          signal?.throwIfAborted()
          local ??= createMarkdownParser()
          return await local.parseInline(markdown)
        }
        return client().parseInline(markdown, signal)
      },
      async document(markdown: string, signal?: AbortSignal) {
        if (typeof Worker === "undefined") {
          local ??= createMarkdownParser()
          return parseMarkdownDocument(local, markdown, () => Boolean(signal?.aborted))
        }
        return client().document(markdown, signal)
      },
    }
  },
})
