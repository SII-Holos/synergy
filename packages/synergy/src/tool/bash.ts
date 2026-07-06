import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./bash.txt"
import { ScopeContext } from "../scope/context"
import { Truncate } from "./truncation"
import { SynergyLinkExecution } from "./synergy-link-execution"
import { LocalBashBackend } from "./bash/local"
import { RemoteBashBackend } from "./bash/remote"
import type { BashMetadata } from "./bash/shared"

const parameters = z.object({
  command: z.string().describe("The command to execute"),
  workdir: z
    .string()
    .describe(
      `The working directory to run the command in. Defaults to the project directory. Use this instead of 'cd' commands.`,
    )
    .optional(),
  description: z
    .string()
    .describe(
      "Clear, concise description of what this command does in 5-10 words. Examples:\nInput: ls\nOutput: Lists files in current directory\n\nInput: git status\nOutput: Shows working tree status\n\nInput: npm install\nOutput: Installs package dependencies\n\nInput: mkdir foo\nOutput: Creates directory 'foo'",
    ),
  background: z
    .boolean()
    .optional()
    .describe(
      "Run command in background. Returns immediately with processId. Use process tool to monitor/interact with the process.",
    ),
  yieldSeconds: z
    .number()
    .positive()
    .optional()
    .describe(
      "Seconds to wait before auto-backgrounding a long-running command. If the command completes before this time, returns normally. Default: 10 (10 seconds).",
    ),
  linkID: z
    .string()
    .optional()
    .describe(
      "Optional Synergy Link target ID. Omit for intentional local execution. Invalid or unavailable supplied linkID values run locally with a warning.",
    ),
  envID: z
    .string()
    .optional()
    .describe("Deprecated: use linkID instead. Accepted temporarily for backward compatibility."),
})

export const BashTool = Tool.define<typeof parameters, BashMetadata>("bash", {
  get description() {
    return DESCRIPTION.replaceAll("${directory}", ScopeContext.current.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))
  },
  parameters,
  async execute(params, ctx) {
    // Accept deprecated envID for backward compat — map to linkID with a warning
    const effectiveLinkID = params.linkID ?? ((params as Record<string, unknown>).envID as string | undefined)
    const linkIDSupplied = Object.hasOwn(params, "linkID") || Object.hasOwn(params, "envID")
    const target = SynergyLinkExecution.resolveExecutionTarget({
      linkID: effectiveLinkID,
      linkIDSupplied,
      tool: "bash",
    })
    if (target.kind === "remote") {
      return RemoteBashBackend.execute(params, target)
    }

    const result = await LocalBashBackend.execute({ ...params, backgroundAfterSeconds: params.yieldSeconds }, ctx)
    if (target.kind === "local_fallback") {
      return SynergyLinkExecution.withLocalFallbackWarning(result, target.warning)
    }
    return result
  },
})
