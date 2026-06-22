import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserRuntime } from "../browser/runtime"
import { Instance } from "../scope/instance"
const parameters = z.object({
  action: z
    .enum(["list", "read", "resolve", "create"])
    .describe("Action: list all annotations, read a specific one, resolve, or create a new annotation"),
  annotationId: z.string().optional().describe("Annotation ID for read/resolve actions"),
  tabId: z.string().optional(),
  ref: z.string().optional().describe("Reference ID for create action"),
  element: z.string().optional().describe("Element selector for create action"),
  comment: z.string().optional().describe("Annotation comment text for create action"),
  styleFeedback: z.record(z.string(), z.string()).optional().describe("Style feedback for create action"),
})

interface BrowserAnnotateMetadata {
  count?: number
  pending?: number
  id?: string
}

export const BrowserAnnotateTool = Tool.define<typeof parameters, BrowserAnnotateMetadata>("browser_annotate", {
  description:
    "Read or manage user annotations on browser pages. Annotations are user comments attached to specific elements or regions of a page.",
  parameters,
  async execute(params, ctx) {
    await BrowserRuntime.ensure()
    const helperCtx: BrowserToolHelper.Context = {
      scopeID: Instance.scope.id,
      sessionID: ctx.sessionID,
    }
    const session = BrowserToolHelper.getOrCreateSession(helperCtx)

    switch (params.action) {
      case "list": {
        const annotations = session.annotations
        if (annotations.length === 0) {
          return { title: "No annotations", output: "No pending annotations.", metadata: { count: 0 } }
        }
        const pending = annotations.filter((a) => !a.resolved)
        const text = pending
          .map(
            (a) =>
              `[${a.id}] ${a.ref || "region"} "${a.comment}"${a.styleFeedback ? ` (style: ${JSON.stringify(a.styleFeedback)})` : ""}`,
          )
          .join("\n")
        return {
          title: `${pending.length} annotations`,
          output: text,
          metadata: { count: annotations.length, pending: pending.length },
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
        const tab = BrowserToolHelper.getTab(helperCtx, params.tabId)
        const comment = params.comment
        if (!comment)
          return { title: "Missing comment", output: "The 'comment' field is required for create.", metadata: {} }
        const input = {
          ref: params.ref,
          element: params.element,
          comment,
          styleFeedback: params.styleFeedback,
          createdBy: "agent" as const,
          tabID: tab.id,
          tabURL: tab.url,
        }
        const ann = session.addAnnotation(input)
        return {
          title: `Created annotation ${ann.id}`,
          output: `Annotation created: "${ann.comment}"`,
          metadata: { id: ann.id },
        }
      }
    }
  },
})
