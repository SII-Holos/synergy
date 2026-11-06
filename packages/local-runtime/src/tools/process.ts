import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import DESCRIPTION from "./process.txt"
import { LocalProcessBackend } from "./process/local"
import type { ProcessMetadata, ProcessParams } from "./process/shared"
import { ToolTimeout } from "@ericsanchezok/synergy-harness/tool/timeout"

const parameters = z
  .object({
    action: z
      .enum(["list", "poll", "log", "write", "send-keys", "kill", "clear", "remove"])
      .describe("Action to perform on the process"),
    processId: z.string().optional().describe("Process ID (required for all actions except list)"),
    data: z.string().optional().describe("Data to write to stdin (for write action)"),
    keys: z.array(z.string()).optional().describe("Key tokens to send (for send-keys action)"),
    offset: z.number().optional().describe("Line offset for log retrieval"),
    limit: z.number().optional().describe("Number of lines to retrieve for log"),
    block: z.boolean().optional().describe("Wait for process to exit before returning (for poll action)"),
    timeoutSeconds: z
      .number()
      .optional()
      .describe(
        `Max seconds to wait when block is true (default: ${ToolTimeout.DEFAULTS.processPollWaitMs / 1_000} seconds).`,
      ),
  })
  .strict()

export const ProcessTool = Tool.define<typeof parameters, ProcessMetadata>(
  "process",
  {
    description: DESCRIPTION,
    parameters,
    async execute(params, ctx) {
      return LocalProcessBackend.execute(params as ProcessParams, ctx)
    },
  },
  { requiresWorkspace: true },
)
