import { z } from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserDownloads } from "../downloads"
import { BrowserCommandService } from "../command-service"
import { BrowserOwner } from "../owner"
import { BrowserExport } from "../export"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { BrowserToolHelper, formatBrowserJSON } from "./browser-shared"
import { AsyncLocalStorage } from "node:async_hooks"

const parameters = z
  .object({
    action: z.enum(["list", "accept", "wait", "cancel", "export"]),
    downloadId: z.string().min(1).max(20_000).optional().describe("Download ID from list; required except for list."),
    timeoutSeconds: z
      .number()
      .int()
      .min(1)
      .max(60)
      .optional()
      .describe("Wait budget in seconds (1–60); valid only for wait; defaults to 30."),
    filePath: z
      .string()
      .min(1)
      .max(20_000)
      .optional()
      .describe("Destination file path in the Workspace; required only for export."),
    page: z.number().int().min(0).optional().describe("Valid only for list; defaults to 0."),
    pageSize: z.number().int().min(1).max(500).optional().describe("Valid only for list; defaults to 100."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action !== "list" && !value.downloadId) {
      ctx.addIssue({ code: "custom", path: ["downloadId"], message: `downloadId is required for ${value.action}.` })
    }
    if (value.action === "list" && value.downloadId !== undefined) {
      ctx.addIssue({ code: "custom", path: ["downloadId"], message: "downloadId is not valid for list." })
    }
    if (value.action !== "wait" && value.timeoutSeconds !== undefined) {
      ctx.addIssue({ code: "custom", path: ["timeoutSeconds"], message: "timeoutSeconds is valid only for wait." })
    }
    if (value.action === "export" && !value.filePath) {
      ctx.addIssue({ code: "custom", path: ["filePath"], message: "filePath is required for export." })
    }
    if (value.action !== "export" && value.filePath !== undefined) {
      ctx.addIssue({ code: "custom", path: ["filePath"], message: "filePath is valid only for export." })
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
  description:
    "List downloads across pages. Accept a waiting download, wait for completion, cancel, or export it to the Workspace.",
  parameters,
  async execute(params, ctx) {
    return BrowserToolHelper.withTask(ctx, async () => {
      const shared = BrowserOwner.shared()
      const historical = BrowserOwner.fromToolContext(ctx)
      await BrowserCommandService.session(shared)
      await BrowserCommandService.session(historical)
      const owner =
        params.downloadId &&
        BrowserDownloads.get(historical, params.downloadId) &&
        !BrowserDownloads.get(shared, params.downloadId)
          ? historical
          : shared
      if (params.action === "list") {
        const all = [...BrowserDownloads.list(shared), ...BrowserDownloads.list(historical)]
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
      if (params.action === "accept") {
        const record = BrowserDownloads.get(owner, params.downloadId!)
        if (!record || record.state !== "awaiting_approval")
          throw new Error("Download is not waiting for approval. List downloads to check its state.")
        const taskContext = AsyncLocalStorage.snapshot()
        await BrowserCommandService.execute(owner, {
          pageId: record.pageID,
          commandId: BrowserToolHelper.operationID(ctx, "download-accept"),
          command: { type: "download.accept", id: record.id },
          authorize: ({ profileId }) =>
            taskContext(() => BrowserToolHelper.authorize(ctx, profileId, record.url, "downloads")),
          signal: ctx.abort,
        })
        return {
          title: "Download accepted",
          output: formatBrowserJSON(publicRecord(record)).output,
          metadata: { id: record.id },
        }
      }
      if (params.action === "wait") {
        const record = await BrowserDownloads.wait(
          owner,
          params.downloadId!,
          (params.timeoutSeconds ?? 30) * 1_000,
          ctx.abort,
        )
        const visible = publicRecord(record)
        const formatted = formatBrowserJSON(visible)
        return {
          title: `Download ${record.id}: ${record.state}`,
          output: formatted.output,
          metadata: { record: visible, outputTruncated: formatted.truncated },
        }
      }
      if (params.action === "cancel") {
        const pending = BrowserDownloads.get(owner, params.downloadId!)
        if (!pending) throw new Error(`Download ${params.downloadId} was not found for this browser owner.`)
        if (pending.state === "pending" || pending.state === "awaiting_approval") {
          await BrowserCommandService.execute(owner, {
            pageId: pending.pageID,
            commandId: BrowserToolHelper.operationID(ctx, "download-cancel"),
            command: { type: "download.cancel", id: params.downloadId! },
            signal: ctx.abort,
          })
        }
        const record = await BrowserDownloads.cancel(owner, params.downloadId!)
        await (await BrowserCommandService.session(owner)).save()
        const visible = publicRecord(record)
        const formatted = formatBrowserJSON(visible)
        return {
          title: `Download ${record.id} cancelled`,
          output: formatted.output,
          metadata: { record: visible, outputTruncated: formatted.truncated },
        }
      }

      const record = BrowserDownloads.get(owner, params.downloadId!)
      const browser = await BrowserCommandService.session(owner)
      const page = browser.pages.find((page) => page.id === record?.pageID)
      if (!record || !page) throw new Error("Open the download's page before exporting it.")
      await BrowserToolHelper.authorize(ctx, page.profileId, record.url, "downloads")
      const target = await BrowserExport.fileTarget(ScopeContext.current.directory, params.filePath!)
      const exported = await BrowserDownloads.exportTo(owner, params.downloadId!, target, ctx.abort)
      return {
        title: `Download ${params.downloadId} exported`,
        output: exported,
        metadata: { id: params.downloadId, path: exported },
      }
    })
  },
})

type PublicDownloadRecord = Omit<BrowserDownloads.DownloadRecord, "path" | "id"> & { downloadId: string }

function publicRecord(record: BrowserDownloads.DownloadRecord): PublicDownloadRecord {
  const { path: _managedPath, id, ...visible } = record
  return { ...visible, downloadId: id }
}
