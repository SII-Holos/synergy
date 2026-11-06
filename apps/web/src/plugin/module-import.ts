import { pluginAssetIntegrity } from "./asset-integrity"

export interface PluginModuleRequest {
  pluginId: string
  url: string
  sha256: string
  signal: AbortSignal
}

export async function importPluginUIModule(input: PluginModuleRequest): Promise<Record<string, unknown>> {
  input.signal.throwIfAborted()
  const integrity = pluginAssetIntegrity(input.sha256)
  const url = new URL(input.url, document.baseURI).href
  const link = document.createElement("link")
  link.rel = "modulepreload"
  link.href = url
  link.integrity = integrity
  link.crossOrigin = "anonymous"
  let abort: (() => void) | undefined
  // modulepreload validates SRI and fills the module map without executing UI:
  // https://html.spec.whatwg.org/multipage/links.html#link-type-modulepreload
  try {
    await Promise.all([
      new Promise<void>((resolve, reject) => {
        abort = () => reject(input.signal.reason)
        const finish = (error?: Error) => {
          if (abort) input.signal.removeEventListener("abort", abort)
          if (error) reject(error)
          else resolve()
        }
        input.signal.addEventListener("abort", abort, { once: true })
        link.onload = () => finish()
        link.onerror = () => finish(new Error(`Plugin ${input.pluginId} module failed integrity or loading checks`))
        document.head.appendChild(link)
      }),
      import("./runtime-components").then((runtime) => runtime.installPluginComponents()),
    ])
    input.signal.throwIfAborted()
    return (await import(/* @vite-ignore */ url)) as Record<string, unknown>
  } finally {
    if (abort) input.signal.removeEventListener("abort", abort)
    link.onload = null
    link.onerror = null
    link.remove()
  }
}
