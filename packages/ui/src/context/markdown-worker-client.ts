import type { MarkdownDocument } from "./markdown-document"
import { markdownMathMarker } from "./marked-math"

type Request = { id: number; markdown?: string; cancel?: boolean; blocks?: boolean; mathMarker?: string }
type Result = { id: number; html?: string; document?: MarkdownDocument; error?: string }
type Port = {
  postMessage(message: Request): void
  onMessage(receive: (event: MessageEvent) => void): void
  onError?(receive: (error: Error) => void): void
  terminate(): void
}

export function createMarkdownWorkerClient(create: () => Port) {
  let port: Port | undefined
  let id = 0
  let bytes = 0
  let disposed = false
  const pending = new Map<number, { resolve(value: Result): void; reject(error: unknown): void; cleanup(): void }>()
  const fail = (error: Error) => {
    const failed = port
    port = undefined
    for (const job of pending.values()) {
      job.cleanup()
      job.reject(error)
    }
    pending.clear()
    failed?.terminate()
  }
  const connect = () => {
    if (port) return port
    const created = create()
    port = created
    created.onMessage((event) => {
      if (port !== created) return
      const result = event.data as Result
      const job = pending.get(result.id)
      if (!job) return
      pending.delete(result.id)
      job.cleanup()
      if (result.error) job.reject(new Error(result.error))
      else job.resolve(result)
    })
    created.onError?.((error) => {
      if (port === created) fail(error)
    })
    return created
  }
  const request = async (markdown: string, signal?: AbortSignal, blocks = false): Promise<Result> => {
    if (disposed) throw new DOMException("Markdown worker disposed", "AbortError")
    signal?.throwIfAborted()
    const size = markdown.length * 2
    if (bytes && bytes + size > 128 * 1024 * 1024) throw new Error("Markdown worker queue exceeds its byte budget")
    const connected = connect()
    const requestID = ++id
    return new Promise((resolve, reject) => {
      let cleaned = false
      const cleanup = () => {
        if (cleaned) return
        cleaned = true
        bytes -= size
        signal?.removeEventListener("abort", abort)
      }
      const abort = () => {
        pending.delete(requestID)
        cleanup()
        try {
          connected.postMessage({ id: requestID, cancel: true })
        } catch {}
        reject(signal?.reason)
      }
      bytes += size
      pending.set(requestID, { resolve, reject, cleanup })
      signal?.addEventListener("abort", abort, { once: true })
      try {
        connected.postMessage({ id: requestID, markdown, blocks, mathMarker: markdownMathMarker() })
      } catch (error) {
        pending.delete(requestID)
        cleanup()
        reject(error)
      }
    })
  }
  return {
    async parse(markdown: string, signal?: AbortSignal) {
      return (await request(markdown, signal)).html ?? ""
    },
    async document(markdown: string, signal?: AbortSignal) {
      const response = await request(markdown, signal, true)
      if (!response.document) throw new Error("Missing Markdown document")
      return response.document
    },
    dispose() {
      disposed = true
      fail(new DOMException("Markdown worker disposed", "AbortError"))
    },
  }
}
