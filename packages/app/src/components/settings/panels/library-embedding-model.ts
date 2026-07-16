import type { EmbeddingStatus } from "@ericsanchezok/synergy-sdk/client"

function wait(ms: number, signal: AbortSignal) {
  if (signal.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"))
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout)
      reject(new DOMException("Aborted", "AbortError"))
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort)
      resolve()
    }, ms)
    signal.addEventListener("abort", abort, { once: true })
  })
}

export function isEmbeddingDownloadActive(status: EmbeddingStatus): boolean {
  return status.mode === "local" && status.asset === "downloading"
}

export async function pollEmbeddingStatus(input: {
  load: () => Promise<EmbeddingStatus>
  onUpdate: (status: EmbeddingStatus) => void
  signal: AbortSignal
  intervalMs?: number
}): Promise<EmbeddingStatus | undefined> {
  while (!input.signal.aborted) {
    const status = await input.load()
    if (input.signal.aborted) return
    input.onUpdate(status)
    if (input.signal.aborted) return
    if (!isEmbeddingDownloadActive(status)) return status
    await wait(input.intervalMs ?? 1000, input.signal)
  }
}
