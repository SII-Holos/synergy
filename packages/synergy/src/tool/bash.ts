import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./bash.txt"
import { Instance } from "../scope/instance"
import { Truncate } from "./truncation"
import { MetaProtocolEnv } from "@ericsanchezok/meta-protocol"
import { RemoteExecution } from "./remote-execution"
import { LocalBashBackend } from "./bash/local"
import { RemoteBashBackend } from "./bash/remote"
import type { BashBackend, BashMetadata } from "./bash/shared"

const parameters = z.object({
  command: z.string().describe("The command to execute"),
  timeout: z
    .number()
    .describe("Optional timeout in seconds. If not specified, commands will time out after 120 seconds (2 minutes).")
    .optional(),
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
    .optional()
    .describe(
      "Seconds to wait before auto-backgrounding a long-running command. If the command completes before this time, returns normally. Default: 10 (10 seconds).",
    ),
  envID: MetaProtocolEnv.EnvID.optional().describe(
    "Optional execution environment ID. Omit for local execution; provide one to target a remote execution backend.",
  ),
})

function selectBackend(envID?: string): BashBackend {
  const target = RemoteExecution.resolveTarget(envID)
  if (target.kind === "remote") {
    return RemoteBashBackend
  }
  return LocalBashBackend
}

// TODO: we may wanna rename this tool so it works better on other shells
export const BashTool = Tool.define<typeof parameters, BashMetadata>("bash", {
  get description() {
    return DESCRIPTION.replaceAll("${directory}", Instance.directory)
      .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
      .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))
  },
  parameters,
  async execute(params, ctx) {
    return selectBackend(params.envID).execute(params, ctx)
  },
})
