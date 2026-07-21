import z from "zod"
import fs from "node:fs/promises"
import path from "node:path"
import { BrowserLocatorSchema, sanitizeBrowserFilename } from "@ericsanchezok/synergy-browser"
import { Tool } from "./tool"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"
import { ScopeContext } from "../scope/context"
import { Filesystem } from "../util/filesystem"

const MAX_FILE_BYTES = 25 * 1024 * 1024
const MAX_REQUEST_BYTES = 50 * 1024 * 1024

export const BrowserUploadTool = Tool.define("browser_upload", {
  description:
    "Upload permission-reviewed workspace files to one uniquely matched file input through isolated staging.",
  parameters: z
    .object({
      target: BrowserLocatorSchema,
      paths: z.array(z.string().min(1).max(20_000)).min(1).max(20),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    const files: Array<{ name: string; mimeType: string; dataBase64: string }> = []
    let totalBytes = 0
    for (const input of params.paths) {
      const candidate = path.resolve(ScopeContext.current.directory, input)
      const candidateInfo = await fs.lstat(candidate)
      if (candidateInfo.isSymbolicLink()) throw new Error(`Upload path must not be a symbolic link: ${input}`)
      const real = await fs.realpath(candidate)
      if (!Filesystem.contains(ScopeContext.current.directory, real))
        throw new Error(`Upload path escapes the active workspace: ${input}`)
      const before = await fs.lstat(real)
      const handle = await fs.open(real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
      try {
        const stat = await handle.stat()
        if (!stat.isFile() || stat.dev !== before.dev || stat.ino !== before.ino) {
          throw new Error(`Upload path changed while it was being reviewed: ${input}`)
        }
        if (stat.size > MAX_FILE_BYTES) throw new Error(`Upload file exceeds 25 MB: ${input}`)
        totalBytes += stat.size
        if (totalBytes > MAX_REQUEST_BYTES) throw new Error("Upload request exceeds 50 MB.")
        const data = await handle.readFile()
        const after = await handle.stat()
        if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) {
          throw new Error(`Upload file changed while it was being read: ${input}`)
        }
        files.push({
          name: sanitizeBrowserFilename(path.basename(real), "upload"),
          mimeType: Bun.file(real).type || "application/octet-stream",
          dataBase64: data.toString("base64"),
        })
      } finally {
        await handle.close()
      }
    }
    const result = await BrowserToolHelper.execute(ctx, { type: "upload", target: params.target, files })
    if (result.type !== "data") throw new Error("Browser upload returned an unexpected result.")
    const formatted = formatBrowserJSON(result.data)
    return {
      title: `Uploaded ${files.length} file${files.length === 1 ? "" : "s"}`,
      output: formatted.output,
      metadata: {
        pageId: page.id,
        files: files.map((file) => file.name),
        totalBytes,
        outputTruncated: formatted.truncated,
      },
    }
  },
})
