import { MAX_TOOL_ICON_BYTES, type ToolIconSource } from "@ericsanchezok/synergy-util/tool-display"
import type { Icon } from "@modelcontextprotocol/sdk/types.js"

// MCP 2025-11-25 icons: https://modelcontextprotocol.io/specification/2025-11-25/basic/index#icons
// Persist bounded image data so transcript rendering never sends credentials or contacts an icon origin.
function imageType(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 24 && bytes.slice(0, 8).every((b, i) => b === [137, 80, 78, 71, 13, 10, 26, 10][i])) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    if (view.getUint32(16) > 1024 || view.getUint32(20) > 1024) return undefined
    return "image/png"
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg"
  const text = new TextDecoder().decode(bytes)
  if (text.startsWith("RIFF") && text.slice(8, 12) === "WEBP") return "image/webp"
  if (!/^\s*(?:<\?xml[^>]*>\s*)?<svg[\s>]/i.test(text)) return undefined
  if (
    /<(?:script|foreignObject|iframe|object|embed|image|use|animate\w*|set)\b|<!DOCTYPE|<!ENTITY|\bon\w+\s*=|\bhref\s*=|url\s*\(|@import/i.test(
      text,
    )
  )
    return undefined
  return "image/svg+xml"
}

type FetchIcon = (url: string, init?: RequestInit) => Promise<Response>

async function loadIcon(
  icon: Icon,
  serverUrl: string | undefined,
  fetcher: FetchIcon,
  signal: AbortSignal = AbortSignal.timeout(2000),
): Promise<ToolIconSource | undefined> {
  try {
    let bytes: Uint8Array
    let declaredType = icon.mimeType
    if (icon.src.startsWith("data:")) {
      const data = /^data:(image\/[a-z+]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(icon.src)
      if (!data || data[2]!.length > Math.ceil(MAX_TOOL_ICON_BYTES / 3) * 4) return undefined
      declaredType ??= data[1]
      bytes = Buffer.from(data[2]!, "base64")
    } else {
      if (!serverUrl) return undefined
      const url = new URL(icon.src)
      if (url.protocol !== "https:" || url.origin !== new URL(serverUrl).origin || url.username || url.password)
        return undefined
      const response = await fetcher(url.href, {
        credentials: "omit",
        redirect: "error",
        signal,
      })
      if (!response.ok || !response.body || Number(response.headers.get("content-length")) > MAX_TOOL_ICON_BYTES) {
        await response.body?.cancel()
        return undefined
      }
      declaredType ??= response.headers.get("content-type")?.split(";")[0]?.trim()
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        while (true) {
          const result = await reader.read()
          if (result.done) break
          size += result.value.byteLength
          if (size > MAX_TOOL_ICON_BYTES) return undefined
          chunks.push(result.value)
        }
      } finally {
        await reader.cancel().catch(() => {})
        reader.releaseLock()
      }
      bytes = Buffer.concat(chunks)
    }
    if (!bytes.length || bytes.length > MAX_TOOL_ICON_BYTES) return undefined
    const mimeType = imageType(bytes)
    if (
      !mimeType ||
      (declaredType?.startsWith("image/") && declaredType.replace("image/jpg", "image/jpeg") !== mimeType)
    )
      return undefined
    return {
      src: `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`,
      mimeType,
      ...(icon.theme ? { theme: icon.theme } : {}),
      ...(icon.sizes ? { sizes: icon.sizes.slice(0, 4) } : {}),
    }
  } catch {
    return undefined
  }
}

export function createMcpIconResolver(fetcher: FetchIcon = fetch) {
  const pending = new Map<string, Promise<ToolIconSource | undefined>>()
  const lanes: Promise<unknown>[] = Array.from({ length: 4 }, () => Promise.resolve())
  let next = 0
  return async (icons: Icon[] | undefined, serverUrl?: string): Promise<ToolIconSource[]> => {
    const deadline = performance.now() + 2000
    const loaded = await Promise.all(
      (icons ?? []).slice(0, 6).map((icon) => {
        const key = JSON.stringify([serverUrl, icon])
        const existing = pending.get(key)
        if (existing) return existing
        const lane = next++ % lanes.length
        const task = lanes[lane]!.then(() => {
          const remaining = Math.ceil(deadline - performance.now())
          if (remaining <= 0) return undefined
          return loadIcon(icon, serverUrl, fetcher, AbortSignal.timeout(remaining))
        })
        pending.set(key, task)
        lanes[lane] = task
        void task.finally(() => pending.delete(key))
        return task
      }),
    )
    const themes = new Set<string>()
    return loaded.filter((icon): icon is ToolIconSource => {
      if (!icon || themes.has(icon.theme ?? "any")) return false
      themes.add(icon.theme ?? "any")
      return true
    })
  }
}

export async function resolveMcpIcons(
  icons: Icon[] | undefined,
  serverUrl?: string,
  fetcher: FetchIcon = fetch,
): Promise<ToolIconSource[]> {
  return createMcpIconResolver(fetcher)(icons, serverUrl)
}
