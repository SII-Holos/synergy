import { z } from "zod"
import { BrowserPageIdSchema, BrowserProfileIdSchema, BrowserProtocolError } from "@ericsanchezok/synergy-browser-core"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { BrowserToolHelper, formatBrowserJSON, withUnknownOutcomeGuidance } from "./browser-shared"
import { BrowserOwner } from "../owner"
import { BrowserProfiles } from "../profiles"

const parameters = z
  .object({
    action: z.enum(["list", "open", "goto", "back", "forward", "reload", "stop", "resume", "close", "current"]),
    pageId: BrowserPageIdSchema.optional().describe("Required except for list and open."),
    profileId: BrowserProfileIdSchema.optional().describe(
      "Identity for a new page; defaults to Personal. List shows available identities.",
    ),
    url: z.string().min(1).max(20_000).optional(),
    ignoreCache: z.boolean().optional(),
    settleMode: z.enum(["networkquiet", "load", "none"]).optional().describe("Navigation defaults to load (15s)."),
    settleTimeoutMs: z.number().int().min(1_000).max(30_000).optional(),
    includeSnapshot: z.boolean().optional().describe("Include current page evidence; defaults to true."),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (!["list", "open"].includes(value.action) && !value.pageId)
      ctx.addIssue({ code: "custom", path: ["pageId"], message: "Choose a pageId from list." })
    if (value.action === "goto" && !value.url)
      ctx.addIssue({ code: "custom", path: ["url"], message: "goto requires a URL." })
    if (value.action !== "open" && value.profileId)
      ctx.addIssue({ code: "custom", path: ["profileId"], message: "Open a new page to use another identity." })
    if (["open", "list"].includes(value.action) && value.pageId)
      ctx.addIssue({ code: "custom", path: ["pageId"], message: "pageId is not used by open or list." })
  })

export const BrowserNavigationTool = Tool.define("browser_navigation", {
  description:
    "List or open browser pages; navigate, inspect or recover a page by pageId. Pages keep their identity and do not change the user's selected tab. Inspect page state before repeating an uncertain action.",
  parameters,
  async execute(params, ctx) {
    const owner = BrowserOwner.fromToolContext(ctx)
    const browser = await BrowserToolHelper.getOrCreateSession(owner)
    if (params.action === "list") {
      const identities = await BrowserProfiles.list()
      return {
        title: "Browser pages",
        output: formatBrowserJSON({
          pages: browser.pages,
          defaultProfileId: identities.defaultProfileId,
          identities: identities.profiles.map(({ id, name, enabled }) => ({ id, name, enabled })),
        }).output,
        metadata: { action: "list", count: browser.pages.length },
      }
    }
    if (params.action === "open") {
      const profile = params.profileId
        ? await BrowserProfiles.requireEnabled(params.profileId)
        : await BrowserProfiles.defaultProfile()
      await BrowserToolHelper.authorize(ctx, profile.id, params.url ?? "about:blank", "access")
      ctx.abort.throwIfAborted()
      const page = await browser.openPage({ url: params.url, profileId: profile.id })
      const state = browser.pages.find((item) => item.id === page.id)!
      return {
        title: "Browser page opened",
        output: formatBrowserJSON(state).output,
        metadata: { action: "open", pageId: page.id, url: page.url, profileId: profile.id },
      }
    }
    const pageId = params.pageId!
    if (params.action === "current") {
      const page = browser.pages.find((page) => page.id === pageId)
      if (!page)
        throw new BrowserProtocolError({
          code: "browser_page_missing",
          message: "Page not found. List pages to choose an available pageId.",
          retryable: false,
          pageId,
        })
      return {
        title: page.title || "Browser page",
        output: formatBrowserJSON(page).output,
        metadata: { action: "current", pageId, url: page.url },
      }
    }
    const settle = {
      settleMode: params.settleMode,
      settleTimeoutMs: params.settleTimeoutMs,
      includeSnapshot: params.includeSnapshot,
    }
    try {
      const command =
        params.action === "goto"
          ? { type: "navigate" as const, url: params.url!, source: "agent" as const, ...settle }
          : params.action === "back" || params.action === "forward"
            ? { type: "history" as const, direction: params.action, ...settle }
            : params.action === "reload"
              ? { type: "reload" as const, ignoreCache: params.ignoreCache, ...settle }
              : { type: params.action }
      const result = await BrowserToolHelper.execute(ctx, pageId, command)
      return {
        title: `Browser: ${params.action}`,
        output: formatBrowserJSON(result).output,
        metadata: { action: params.action, pageId, resultType: result.type },
      }
    } catch (error) {
      throw withUnknownOutcomeGuidance(error, `browser_navigation ${params.action}`)
    }
  },
})
