import z from "zod"
import { Tool } from "./tool"
import { BrowserToolHelper } from "./browser-shared"
import { BrowserOwner } from "../browser/owner"

const parameters = z
  .object({
    action: z.enum(["goto", "back", "forward", "reload", "stop", "resume", "close", "current"]),
    url: z.string().min(1).max(20_000).optional().describe("Required only for goto."),
    ignoreCache: z.boolean().optional().describe("Valid only for reload."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.action === "goto" && !value.url) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url is required for goto." })
    }
    if (value.action !== "goto" && value.url !== undefined) {
      ctx.addIssue({ code: "custom", path: ["url"], message: "url is valid only for goto." })
    }
    if (value.action !== "reload" && value.ignoreCache !== undefined) {
      ctx.addIssue({ code: "custom", path: ["ignoreCache"], message: "ignoreCache is valid only for reload." })
    }
  })

interface BrowserNavigationMetadata {
  status: string
  pageId?: string
  url?: string
  title?: string
  isLoading?: boolean
  action?: string
  resultType?: string
}

export const BrowserNavigationTool = Tool.define<typeof parameters, BrowserNavigationMetadata>("browser_navigation", {
  description:
    "Navigate, resume, close, or read the one browser page owned by the current session. Navigation can return while loading; use browser_wait before asserting page content or title. Close is terminal for the current page and should be tested only after all navigation, debugging, and external-site checks; a later goto creates a new page.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    if (params.action === "current") {
      const session = await BrowserToolHelper.getOrCreateSession(owner)
      const page = session.page ?? session.descriptor
      const isLoading = session.page?.loading ?? false
      return {
        title: page ? "Current browser page" : "No browser page",
        output: page
          ? `Status: ${session.status}\nLoading: ${isLoading ? "yes" : "no"}\nURL: ${page.url}\nTitle: ${page.title || (isLoading ? "(loading)" : "(empty)")}`
          : "No browser page is open.",
        metadata: {
          status: session.status,
          pageId: page?.id,
          url: page?.url,
          title: page?.title,
          isLoading,
        },
      }
    }

    let result
    if (params.action === "goto") {
      result = await BrowserToolHelper.execute(ctx, { type: "navigate", url: params.url!, source: "agent" })
    } else if (params.action === "back")
      result = await BrowserToolHelper.execute(ctx, { type: "history", direction: "back" })
    else if (params.action === "forward")
      result = await BrowserToolHelper.execute(ctx, { type: "history", direction: "forward" })
    else if (params.action === "reload")
      result = await BrowserToolHelper.execute(ctx, { type: "reload", ignoreCache: params.ignoreCache })
    else result = await BrowserToolHelper.execute(ctx, { type: params.action })

    const session = await BrowserToolHelper.getOrCreateSession(owner)
    const page = session.page ?? session.descriptor
    const resultPage = result.type === "navigation" || result.type === "page" ? result.page : undefined
    const isLoading = resultPage?.isLoading ?? session.page?.loading ?? false
    return {
      title: `Browser navigation: ${params.action}`,
      output: page
        ? `Loading: ${isLoading ? "yes" : "no"}\nURL: ${page.url}\nTitle: ${page.title || (isLoading ? "(loading)" : "(empty)")}`
        : "Browser page closed.",
      metadata: {
        action: params.action,
        resultType: result.type,
        status: session.status,
        pageId: page?.id,
        url: page?.url,
        title: page?.title,
        isLoading,
      },
    }
  },
})
