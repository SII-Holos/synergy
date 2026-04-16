import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Asset } from "../asset/asset"
import { Instance } from "../scope/instance"
import { Identifier } from "../id/id"

const DESCRIPTION = `Deliver a file to the user by making it available for download. Use this tool after generating or obtaining a file that the user needs — PDFs, images, documents, archives, etc.

The file will be uploaded to the asset store and delivered as a downloadable attachment in the conversation.

Usage notes:
- The file_path must point to an existing file on the local filesystem
- Use an optional filename to control the display name shown to the user
- This tool is for delivering files to the user, not for reading them — use the read tool for that`

export const AttachTool = Tool.define("attach", {
  description: DESCRIPTION,
  parameters: z.object({
    file_path: z.union([z.string(), z.array(z.string())]).describe("Absolute or relative path to the file to deliver"),
    filename: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Display name for the file (defaults to the original filename)"),
  }),
  async execute(params, ctx) {
    const paths = Array.isArray(params.file_path) ? params.file_path : [params.file_path]
    const filenames = params.filename ? (Array.isArray(params.filename) ? params.filename : [params.filename]) : []

    const files: { assetId: string; filename: string; mime: string; size: number }[] = []
    const attachments: {
      id: string
      sessionID: string
      messageID: string
      type: "file"
      mime: string
      filename: string
      url: string
    }[] = []

    for (let i = 0; i < paths.length; i++) {
      let filePath = paths[i]
      if (!path.isAbsolute(filePath)) {
        filePath = path.join(Instance.directory, filePath)
      }

      const file = Bun.file(filePath)
      if (!(await file.exists())) {
        throw new Error(`File not found: ${filePath}`)
      }

      const buffer = Buffer.from(await file.arrayBuffer())
      const mime = file.type || "application/octet-stream"
      const filename = filenames[i] ?? path.basename(filePath)
      const assetId = await Asset.write(buffer, mime)

      files.push({ assetId, filename, mime, size: buffer.length })
      attachments.push({
        id: Identifier.ascending("part"),
        sessionID: ctx.sessionID,
        messageID: ctx.messageID,
        type: "file",
        mime,
        filename,
        url: `asset://${assetId}`,
      })
    }

    const totalSize = files.reduce((sum, f) => sum + f.size, 0)
    const output =
      files.length === 1
        ? `File delivered: ${files[0].filename} (${formatSize(files[0].size)})`
        : `${files.length} files delivered (${formatSize(totalSize)}): ${files.map((f) => f.filename).join(", ")}`

    return {
      title: files.length === 1 ? files[0].filename : `${files.length} files`,
      output,
      metadata: {
        truncated: false,
        files,
      },
      attachments,
    }
  },
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
