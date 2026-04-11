import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./process.txt"
import { MetaProtocolEnv } from "@ericsanchezok/meta-protocol"
import { RemoteExecution } from "./remote-execution"
import { LocalProcessBackend } from "./process/local"
import { RemoteProcessBackend } from "./process/remote"
import type { ProcessMetadata, ProcessParams } from "./process/shared"

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
  timeout: z.number().optional().describe("Max seconds to wait when block is true (default: 30)"),
  envID: MetaProtocolEnv.EnvID.optional().describe(
    "Optional execution environment ID. Omit for local execution; provide one to target a remote execution backend.",
  ),
})

export const ProcessTool = Tool.define<typeof parameters, ProcessMetadata>("process", {
  description: DESCRIPTION,
  parameters,
  async execute(params) {
    const target = RemoteExecution.resolveTarget(params.envID)
    if (target.kind === "remote") {
      return RemoteProcessBackend.execute(params, target.envID)
    }

    return LocalProcessBackend.execute(params as ProcessParams)
  },
})
