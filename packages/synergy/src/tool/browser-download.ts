import z from "zod"
import fs from "fs/promises"
import path from "path"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { BrowserPolicy } from "../browser/policy"
import { Instance } from "../scope/instance"
import { Global } from "../global"

const MAX_DOWNLOAD_SIZE = 100 * 1024 * 1024 // 100MB

function downloadsDir(scopeID: string): string {
  return path.join(Global.Path.data, "browser", "downloads", scopeID)
}

function extFromContentType(contentType: string): string {
  const mime = contentType.split(";")[0].trim().toLowerCase()
  const extMap: Record<string, string> = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "image/svg+xml": ".svg",
    "text/plain": ".txt",
    "text/html": ".html",
    "text/css": ".css",
    "text/csv": ".csv",
    "text/javascript": ".js",
    "application/json": ".json",
    "application/pdf": ".pdf",
    "application/zip": ".zip",
    "application/gzip": ".gz",
    "application/x-tar": ".tar",
  }
  return extMap[mime] ?? ".bin"
}

function filenameFromURL(url: string): string {
  try {
    const parsed = new URL(url)
    const basename = path.basename(parsed.pathname)
    if (basename && basename.includes(".")) return basename
    return "download"
  } catch {
    return "download"
  }
}

export const BrowserDownloadTool = Tool.define("browser_download", {
  description:
    "Download a file from a URL and save it to the browser downloads directory. Enforces size (max 100MB) and MIME type restrictions. Returns the saved file path and size.",
  parameters: z.object({
    url: z.string().describe("The URL of the asset to download."),
    filename: z.string().describe("Optional filename for the saved file.").optional(),
    tabId: z.string().describe("Browser tab ID for policy context. Uses the active tab if omitted.").optional(),
  }),
  async execute(params, ctx) {
    const workspace = Instance.directory

    // Check URL policy
    const policyResult = BrowserPolicy.evaluateURL(params.url, workspace)
    if (policyResult.decision !== "allow") {
      throw new Error(`Download denied by URL policy: ${policyResult.reason}`)
    }

    // Optionally check tab's network buffer for MIME type hint
    let networkMimeType: string | undefined
    try {
      await BrowserRuntime.ensure()
      const helperCtx: BrowserToolHelper.Context = {
        scopeID: Instance.scope.id,
        sessionID: ctx.sessionID,
      }
      const tab = BrowserToolHelper.getTab(helperCtx, params.tabId)
      const requests = await tab.networkRequests(50)
      const matched = requests.find((r) => r.url === params.url && r.mimeType)
      if (matched?.mimeType) {
        networkMimeType = matched.mimeType
      }
    } catch {
      // Tab may not be available — proceed without network buffer hint
    }

    // Fetch the URL
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(new Error("Download timeout after 120s")), 120_000)

    let response: Response
    try {
      response = await fetch(params.url, {
        signal: AbortSignal.any([controller.signal, ctx.abort]),
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
      })
    } finally {
      clearTimeout(timeoutId)
    }

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`)
    }

    // Determine MIME type — prefer explicit Content-Type header, fall back to network buffer hint
    const contentType = response.headers.get("content-type") ?? networkMimeType ?? "application/octet-stream"
    const mimeType = contentType.split(";")[0].trim().toLowerCase()

    // Check MIME type policy
    if (!BrowserPolicy.isDownloadAllowed(mimeType)) {
      throw new Error(`Download denied: MIME type "${mimeType}" is not allowed`)
    }

    // Enforce size limit
    const contentLength = response.headers.get("content-length")
    if (contentLength) {
      const size = parseInt(contentLength, 10)
      if (!Number.isFinite(size)) {
        throw new Error("Download failed: invalid Content-Length header")
      }
      if (size > MAX_DOWNLOAD_SIZE) {
        throw new Error(`Download denied: content length ${size} exceeds max ${MAX_DOWNLOAD_SIZE} bytes`)
      }
    }

    const arrayBuffer = await response.arrayBuffer()
    if (arrayBuffer.byteLength > MAX_DOWNLOAD_SIZE) {
      throw new Error(`Download denied: response size ${arrayBuffer.byteLength} exceeds max ${MAX_DOWNLOAD_SIZE} bytes`)
    }

    // Determine filename
    let filename = params.filename
    if (!filename) {
      filename = filenameFromURL(params.url)
      if (!filename.includes(".")) {
        filename += extFromContentType(contentType)
      }
    }

    // Save to ~/.synergy/data/browser/downloads/{scopeID}/{filename}
    const dir = downloadsDir(Instance.scope.id)
    await fs.mkdir(dir, { recursive: true })

    // Avoid overwriting: append -n if file exists
    let savePath = path.join(dir, filename)
    if (await Bun.file(savePath).exists()) {
      const ext = path.extname(filename)
      const base = path.basename(filename, ext)
      let counter = 1
      while (await Bun.file(savePath).exists()) {
        savePath = path.join(dir, `${base}-${counter}${ext}`)
        counter++
      }
    }

    await Bun.write(savePath, Buffer.from(arrayBuffer))

    return {
      title: `Downloaded: ${path.basename(savePath)}`,
      output: `Downloaded ${params.url} to ${savePath} (${(arrayBuffer.byteLength / 1024).toFixed(1)} KB)`,
      metadata: {
        path: savePath,
        size: arrayBuffer.byteLength,
        mimeType,
      },
    }
  },
})
