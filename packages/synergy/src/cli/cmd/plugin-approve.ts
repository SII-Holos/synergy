import * as prompts from "@clack/prompts"
import type { Argv } from "yargs"
import type { ApprovalReview } from "../../plugin/consent/approval-service"
import { ApprovalReviewSchema } from "../../plugin/consent/approval-service"
import type { PluginStatus } from "../../plugin/status"
import { UI } from "../ui"
import { cmd } from "./cmd"
import { approvalSubmitBody, printApprovalReview } from "./plugin-consent"
import { attachOption, ensureServer, fetchPluginApi, PluginApiError } from "./plugin-server"

export const PluginApproveCommand = cmd({
  command: "approve <plugin>",
  describe: "review and approve the current plugin artifact",
  builder: (yargs: Argv) =>
    yargs
      .positional("plugin", {
        type: "string",
        describe: "plugin id",
        demandOption: true,
      })
      .options(attachOption),
  async handler(args) {
    const serverUrl = args.attach
    if (!(await ensureServer(serverUrl))) process.exit(1)

    const pluginId = args.plugin as string
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      UI.error("Plugin approval requires an interactive terminal. Use the Web plugin details instead.")
      process.exitCode = 1
      return
    }

    try {
      let review = await fetchPluginApi<ApprovalReview>(serverUrl, `/${pluginId}/approval-review`)
      while (true) {
        printApprovalReview(review)
        const confirmed = await prompts.confirm({
          message: `Approve ${review.name}@${review.version} and reload the plugin?`,
        })
        if (confirmed !== true || prompts.isCancel(confirmed)) {
          UI.println(`${UI.Style.TEXT_DIM}Not approved. The plugin remains disabled.${UI.Style.TEXT_NORMAL}`)
          return
        }

        try {
          const status = await fetchPluginApi<PluginStatus>(serverUrl, "/approve", "POST", approvalSubmitBody(review))
          UI.println(
            `${UI.Style.TEXT_SUCCESS}✔${UI.Style.TEXT_NORMAL} ${status.name}@${status.version ?? "?"} is loaded`,
          )
          return
        } catch (error) {
          const staleReview = staleApprovalReview(error)
          if (!staleReview) throw error
          UI.println(
            `${UI.Style.TEXT_WARNING}Plugin changed while you were reviewing it. Review the latest artifact before approving.${UI.Style.TEXT_NORMAL}`,
          )
          review = staleReview
        }
      }
    } catch (error) {
      const message =
        error instanceof PluginApiError ? formatApiError(error) : error instanceof Error ? error.message : String(error)
      UI.error(`Approval failed: ${message}`)
      process.exitCode = 1
    }
  },
})

function staleApprovalReview(error: unknown): ApprovalReview | undefined {
  if (!(error instanceof PluginApiError) || error.status !== 409 || error.body.code !== "stale_review") return
  const parsed = ApprovalReviewSchema.safeParse(error.body.review)
  return parsed.success ? parsed.data : undefined
}

function formatApiError(error: PluginApiError): string {
  return error.body.code ? `${error.body.code}: ${error.message}` : error.message
}
