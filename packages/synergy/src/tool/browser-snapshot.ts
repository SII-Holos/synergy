import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper, formatSnapshotText } from "./browser-shared"

export const BrowserSnapshotTool = Tool.define("browser_snapshot", {
  description:
    "Capture the current accessibility and interactive DOM snapshot. Returned opaque refs are valid only with the returned snapshotId and current document generation.",
  parameters: z
    .object({
      query: z
        .string()
        .max(20_000)
        .optional()
        .describe("Bounded text query; matching nodes include their ancestor path."),
      maxNodes: z.number().int().min(1).max(5000).default(500),
      interactiveOnly: z.boolean().default(false),
      maxDepth: z.number().int().min(0).max(100).optional(),
    })
    .strict(),
  async execute(params, ctx) {
    const page = await BrowserToolHelper.resolvePage(ctx)
    return BrowserToolHelper.withActivity(
      ctx,
      page,
      "reading",
      "browser_snapshot",
      "Reading page structure",
      async () => {
        const result = await BrowserToolHelper.execute(ctx, {
          type: "snapshot",
          query: params.query,
          maxNodes: params.maxNodes,
        })
        if (result.type !== "snapshot") throw new Error("Browser snapshot returned an unexpected result.")
        const formatted = formatSnapshotText(result.elements, params)
        return {
          title: `Snapshot of ${page.url || page.title || "page"}`,
          output: `snapshotId: ${result.snapshotId}\n${formatted.output}`,
          metadata: {
            pageId: page.id,
            url: page.url,
            snapshotId: result.snapshotId,
            elementsCount: result.elements.length,
            truncated: result.truncated || formatted.truncated,
            outputTruncated: formatted.truncated,
          },
        }
      },
    )
  },
})
