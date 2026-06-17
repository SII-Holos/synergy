import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Asset } from "../asset/asset"
import { Instance } from "../scope/instance"
import { Identifier } from "../id/id"

const DESCRIPTION = `Deliver files to the user by making them available as conversation attachments. Use this after generating or obtaining user-facing artifacts such as PDFs, images, documents, archives, exports, plots, rendered figures, screenshots, or compiled paper outputs.

The file will be uploaded to the asset store and delivered as an attachment in the conversation. Image files render inline in supported clients; PDFs and other files render as preview/download cards.

Usage notes:
- The file_path must point to an existing file on the local filesystem
- Use an optional filename to control the display name shown to the user
- After a bash command, script, or document build creates a visual result (.png, .jpg, .svg, .pdf, .html), use this tool to show the result instead of only printing the path
- This tool is for delivering files to the user, not for reading them into your own context — use read or look_at for that`

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

      if (!ctx.extra?.["bypassCwdCheck"] && !Instance.contains(filePath)) {
        const parentDir = path.dirname(filePath)
        await ctx.ask({
          permission: "external_directory",
          patterns: [parentDir],
          metadata: {
            filepath: filePath,
            parentDir,
            workspaceBoundary: true,
            outsideWorkspace: true,
            nonBypassable: true,
          },
        })
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
