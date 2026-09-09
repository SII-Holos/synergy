declare const SYNERGY_STANDALONE: boolean | undefined

const MAX_SVG_BYTES = 2 * 1024 * 1024
const RASTER_TIMEOUT_MS = 5_000

type WorkerResult = { ok: true; png: Uint8Array } | { ok: false; error: string }

export async function rasterizeSvgPreview(svg: Uint8Array, options?: { timeoutMs?: number }): Promise<Uint8Array> {
  if (svg.byteLength === 0 || svg.byteLength > MAX_SVG_BYTES) {
    throw new Error(`SVG preview input must be between 1 and ${MAX_SVG_BYTES} bytes`)
  }
  const timeoutMs = options?.timeoutMs ?? RASTER_TIMEOUT_MS

  return new Promise<Uint8Array>((resolve, reject) => {
    const worker = new Worker(workerEntrypoint(), { ref: false })
    let settled = false
    const timer = setTimeout(() => settle(new Error(`SVG preview rasterization exceeded ${timeoutMs}ms`)), timeoutMs)

    function settle(error?: Error, png?: Uint8Array) {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.onmessage = null
      worker.onerror = null
      worker.terminate()
      if (error) reject(error)
      else if (png) resolve(png)
      else reject(new Error("SVG preview worker returned no image"))
    }

    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const result = event.data
      if (result.ok) settle(undefined, result.png)
      else settle(new Error(result.error))
    }
    worker.onerror = (event) => settle(new Error(event.message || "SVG preview worker failed"))
    worker.postMessage({ svg })
  })
}

function workerEntrypoint(): string | URL {
  if (typeof SYNERGY_STANDALONE !== "undefined" && SYNERGY_STANDALONE) {
    return "./src/channel/provider/feishu/svg-raster-worker.ts"
  }
  return new URL("./svg-raster-worker.ts", import.meta.url)
}
