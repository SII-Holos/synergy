import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"
import { truncateBrowserOutput } from "./browser-shared"

const parameters = z
  .object({
    action: z
      .enum(["list", "read", "resolve", "create"])
      .describe("Action: list all annotations, read a specific one, resolve, or create a new annotation"),
    annotationId: z.string().min(1).max(20_000).optional().describe("Annotation ID for read/resolve actions"),
    pageId: z.string().min(1).max(20_000).optional(),
    ref: z.string().min(1).max(20_000).optional().describe("Reference ID for create action"),
    element: z.string().min(1).max(20_000).optional().describe("Element selector for create action"),
    comment: z.string().min(1).max(20_000).optional().describe("Annotation comment text for create action"),
    styleFeedback: z
      .record(z.string().max(1_000), z.string().max(10_000))
      .optional()
      .describe("Style feedback for create action"),
    page: z.number().int().min(0).optional().describe("Valid only for list; defaults to 0."),
    pageSize: z.number().int().min(1).max(100).optional().describe("Valid only for list; defaults to 50."),
  })
  .strict()
  .superRefine((value, ctx) => {
    const createFields = ["pageId", "ref", "element", "comment", "styleFeedback"] as const
    if ((value.action === "read" || value.action === "resolve") && !value.annotationId) {
      ctx.addIssue({ code: "custom", path: ["annotationId"], message: `annotationId is required for ${value.action}.` })
    }
    if (value.action !== "read" && value.action !== "resolve" && value.annotationId !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["annotationId"],
        message: "annotationId is valid only for read or resolve.",
      })
    }
    if (value.action === "create" && !value.comment) {
      ctx.addIssue({ code: "custom", path: ["comment"], message: "comment is required for create." })
    }
    if (value.action !== "create") {
      for (const field of createFields) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: "custom", path: [field], message: `${field} is valid only for create.` })
        }
      }
    }
    if (value.action !== "list" && (value.page !== undefined || value.pageSize !== undefined)) {
      ctx.addIssue({ code: "custom", path: ["page"], message: "page and pageSize are valid only for list." })
    }
  })

interface BrowserAnnotateMetadata {
  count?: number
  pending?: number
  id?: string
  page?: number
  outputTruncated?: boolean
}

export const BrowserAnnotateTool = Tool.define<typeof parameters, BrowserAnnotateMetadata>("browser_annotate", {
  description:
    "Read or manage user annotations on browser pages. Annotations are user comments attached to specific elements or regions of a page.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const session = await BrowserToolHelper.getOrCreateSession(owner)

    switch (params.action) {
      case "list": {
        const annotations = session.annotations
        if (annotations.length === 0) {
          return { title: "No annotations", output: "No pending annotations.", metadata: { count: 0 } }
        }
        const pending = annotations.filter((a) => !a.resolved)
        const page = params.page ?? 0
        const pageSize = params.pageSize ?? 50
        const visible = pending.slice(page * pageSize, (page + 1) * pageSize)
        const formatted = truncateBrowserOutput(
          visible
            .map(
              (a) =>
                `[${a.id}] ${a.ref || "region"} "${a.comment}"${a.styleFeedback ? ` (style: ${JSON.stringify(a.styleFeedback)})` : ""}`,
            )
            .join("\n") || "No pending annotations.",
        )
        return {
          title: `${pending.length} annotations`,
          output: formatted.output,
          metadata: {
            count: annotations.length,
            pending: pending.length,
            page,
            outputTruncated: formatted.truncated,
          },
        }
      }
      case "read": {
        const a = session.annotations.find((a) => a.id === params.annotationId)
        if (!a)
          return { title: "Annotation not found", output: `Annotation ${params.annotationId} not found.`, metadata: {} }
        return {
          title: `Annotation ${a.id}`,
          output: `Element: ${a.ref || a.element || "region"}\nComment: ${a.comment}${a.styleFeedback ? `\nStyle feedback: ${JSON.stringify(a.styleFeedback)}` : ""}\nResolved: ${a.resolved}`,
          metadata: { ...a },
        }
      }
      case "resolve": {
        const a = session.annotations.find((a) => a.id === params.annotationId)
        if (!a)
          return { title: "Annotation not found", output: `Annotation ${params.annotationId} not found.`, metadata: {} }
        a.resolved = true
        await session.save()
        return {
          title: `Resolved annotation ${a.id}`,
          output: `Marked annotation "${a.comment}" as resolved.`,
          metadata: { id: a.id },
        }
      }
      case "create": {
        const page = await BrowserToolHelper.getPage(owner, params.pageId)
        const input = {
          ref: params.ref,
          element: params.element,
          comment: params.comment!,
          styleFeedback: params.styleFeedback,
          createdBy: "agent" as const,
          pageID: page.id,
          pageURL: page.url,
        }
        const ann = await session.addAnnotation(input)
        return {
          title: `Created annotation ${ann.id}`,
          output: `Annotation created: "${ann.comment}"`,
          metadata: { id: ann.id },
        }
      }
    }
  },
})
