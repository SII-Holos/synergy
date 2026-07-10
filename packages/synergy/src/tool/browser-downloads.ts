import z from "zod"
import { Tool } from "./tool"
import { BrowserDownloads } from "../browser/downloads"
import { BrowserCommandService } from "../browser/command-service"
import { BrowserOwner } from "../browser/owner"
import { BrowserExport } from "../browser/export"
import { ScopeContext } from "../scope/context"
import { formatBrowserJSON } from "./browser-shared"

const parameters = z
  .object({
    action: z.enum(["list", "wait", "cancel", "export"]),
    id: z.string().min(1).max(20_000).optional().describe("Required for wait, cancel, and export."),
    timeoutMs: z.number().int().min(100).max(60_000).optional().describe("Valid only for wait; defaults to 30000."),
    path: z.string().min(1).max(20_000).optional().describe("Required only for export."),
    page: z.number().int().min(0).optional().describe("Valid only for list; defaults to 0."),
    pageSize: z.number().int().min(1).max(500).optional().describe("Valid only for list; defaults to 100."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action !== "list" && !value.id) {
      ctx.addIssue({ code: "custom", path: ["id"], message: `id is required for ${value.action}.` })
    }
    if (value.action === "list" && value.id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id is not valid for list." })
    }
    if (value.action !== "wait" && value.timeoutMs !== undefined) {
      ctx.addIssue({ code: "custom", path: ["timeoutMs"], message: "timeoutMs is valid only for wait." })
    }
    if (value.action === "export" && !value.path) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "path is required for export." })
    }
    if (value.action !== "export" && value.path !== undefined) {
      ctx.addIssue({ code: "custom", path: ["path"], message: "path is valid only for export." })
    }
    if (value.action !== "list" && (value.page !== undefined || value.pageSize !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["page"], message: "page and pageSize are valid only for list." })
    }
  })

interface BrowserDownloadsMetadata {
  records?: PublicDownloadRecord[]
  record?: PublicDownloadRecord
  id?: string
  path?: string
  page?: number
  total?: number
  outputTruncated?: boolean
}

export const BrowserDownloadsTool = Tool.define<typeof parameters, BrowserDownloadsMetadata>("browser_downloads", {
  description: "List, wait for, cancel, or export owner-isolated managed browser downloads.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    if (params.action === "list") {
      const all = BrowserDownloads.list(owner)
      const page = params.page ?? 0
      const pageSize = params.pageSize ?? 100
      const records = all.slice(page * pageSize, (page + 1) * pageSize).map(publicRecord)
      const formatted = formatBrowserJSON({ records, page, total: all.length })
      return {
        title: `Browser downloads (${all.length})`,
        output: formatted.output,
        metadata: { records, page, total: all.length, outputTruncated: formatted.truncated },
      }
    }
    if (params.action === "wait") {
      const record = await BrowserDownloads.wait(owner, params.id!, params.timeoutMs ?? 30_000, ctx.abort)
      const visible = publicRecord(record)
      const formatted = formatBrowserJSON(visible)
      return {
        title: `Download ${record.id}: ${record.state}`,
        output: formatted.output,
        metadata: { record: visible, outputTruncated: formatted.truncated },
      }
    }
    if (params.action === "cancel") {
      const pending = BrowserDownloads.get(owner, params.id!)
      if (!pending) throw new Error(`Download ${params.id} was not found for this browser owner.`)
      if (pending.state === "pending") {
        await BrowserCommandService.execute(owner, {
          commandId: `${ctx.callID ?? ctx.messageID}:download-cancel`,
          command: { type: "download.cancel", id: params.id! },
          signal: ctx.abort,
        })
      }
      const record = await BrowserDownloads.cancel(owner, params.id!)
      await (await BrowserCommandService.session(owner)).save()
      const visible = publicRecord(record)
      const formatted = formatBrowserJSON(visible)
      return {
        title: `Download ${record.id} cancelled`,
        output: formatted.output,
        metadata: { record: visible, outputTruncated: formatted.truncated },
      }
    }

    const target = await BrowserExport.fileTarget(ScopeContext.current.directory, params.path!)
    const exported = await BrowserDownloads.exportTo(owner, params.id!, target)
    return { title: `Download ${params.id} exported`, output: exported, metadata: { id: params.id, path: exported } }
  },
})

type PublicDownloadRecord = Omit<BrowserDownloads.DownloadRecord, "path">

function publicRecord(record: BrowserDownloads.DownloadRecord): PublicDownloadRecord {
  const { path: _managedPath, ...visible } = record
  return visible
}
