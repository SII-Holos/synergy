import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./process.txt"
import { SynergyLinkExecution } from "./synergy-link-execution"
import { LocalProcessBackend } from "./process/local"
import { RemoteProcessBackend } from "./process/remote"
import type { ProcessMetadata, ProcessParams } from "./process/shared"
import { ToolTimeout } from "./timeout"

const parameters = z.object({
  action: z
    .enum(["list", "poll", "log", "write", "send-keys", "kill", "clear", "remove"])
    .describe("Action to perform on the process"),
  processId: z.string().optional().describe("Process ID (required for all actions except list)"),
  data: z.string().optional().describe("Data to write to stdin (for write action)"),
  keys: z.array(z.string()).optional().describe("Key tokens to send (for send-keys action)"),
  offset: z.number().optional().describe("Line offset for log retrieval"),
  limit: z.number().optional().describe("Number of lines to retrieve for log"),
  block: z.boolean().optional().describe("Wait for process to exit before returning (for poll action)"),
  timeout: z
    .number()
    .optional()
    .describe(`Max seconds to wait when block is true (default: ${ToolTimeout.DEFAULTS.processPollWaitMs / 1_000})`),
  linkID: z
    .string()
    .optional()
    .describe(
      "Legacy Synergy Link instance ID. Prefer targetID. Omit both fields for intentional local execution. A supplied remote target never falls back locally.",
    ),
  targetID: z.string().optional().describe("Persisted Synergy Link target ID returned by connect list_targets."),
  envID: z
    .string()
    .optional()
    .describe("Deprecated: use linkID instead. Accepted temporarily for backward compatibility."),
})

export const ProcessTool = Tool.define<typeof parameters, ProcessMetadata>("process", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const effectiveLinkID = params.linkID ?? ((params as Record<string, unknown>).envID as string | undefined)
    const linkIDSupplied = Object.hasOwn(params, "linkID") || Object.hasOwn(params, "envID")
    const target = await SynergyLinkExecution.resolveExecutionTarget({
      targetID: params.targetID,
      targetIDSupplied: Object.hasOwn(params, "targetID"),
      linkID: effectiveLinkID,
      linkIDSupplied,
      tool: "process",
      agent: ctx.agent,
    })
    if (target.kind === "remote") {
      return RemoteProcessBackend.execute(params, target)
    }

    return LocalProcessBackend.execute(params as ProcessParams, ctx)
  },
})
