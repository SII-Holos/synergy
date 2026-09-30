import z from "zod"
import { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import DESCRIPTION from "./bash.txt"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Truncate } from "@ericsanchezok/synergy-harness/tool/truncation"
import { LocalBashBackend } from "./bash/local"
import type { BashMetadata, BashResult } from "@ericsanchezok/synergy-harness/tool/bash-contract"

export function modelVisibleBashResult(result: BashResult): BashResult {
  if (result.metadata.background) return result
  const { exit, signal } = result.metadata
  const completion = signal
    ? `Shell exited with signal ${signal}.`
    : typeof exit === "number"
      ? `Shell exited with code ${exit}.`
      : "Shell exit status unknown."
  const separator = result.output.endsWith("\n") ? "\n" : "\n\n"
  return { ...result, output: result.output ? `${result.output}${separator}${completion}` : completion }
}

const parameters = z
  .object({
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
        "Seconds to wait before auto-backgrounding a long-running command. If the command completes before this time, returns normally. Default: 30 (30 seconds).",
      ),
  })
  .strict()

export const BashTool = Tool.define<typeof parameters, BashMetadata>(
  "bash",
  {
    get description() {
      return DESCRIPTION.replaceAll(
        "${directory}",
        ScopeContext.current.workspace?.path ?? "the selected Environment working directory",
      )
        .replaceAll("${maxLines}", String(Truncate.MAX_LINES))
        .replaceAll("${maxBytes}", String(Truncate.MAX_BYTES))
    },
    parameters,
    async execute(params, ctx) {
      return modelVisibleBashResult(await LocalBashBackend.execute(params, ctx))
    },
  },
  { requiresWorkspace: false, requiresExecution: "exec" },
)
