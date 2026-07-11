import { cmd } from "./cmd"
import { Diagnostics } from "@/observability/diagnostics"
import { UI } from "../ui"

export const DiagnosticsCommand = cmd({
  command: "diagnostics",
  describe: "create a local diagnostics package",
  builder: (yargs) =>
    yargs
      .option("session", {
        type: "string",
        describe: "include indexed observability events for a specific session",
      })
      .option("since", {
        type: "string",
        describe: "include indexed observability events since a duration like 30m, 2h, or 7d",
      })
      .option("output", {
        alias: "o",
        type: "string",
        describe: "path for the generated .tar.gz package",
      }),
  handler: async (args) => {
    const sinceMs = args.since ? parseDuration(args.since) : undefined
    if (args.since && sinceMs === undefined) {
      UI.error(`Invalid --since duration: ${args.since}`)
      process.exitCode = 1
      return
    }

    const result = await Diagnostics.createPackage({
      sessionID: args.session,
      sinceMs,
      output: args.output,
    })

    UI.println(`Diagnostics package: ${result.output}`)
    UI.println(`  Indexed events: ${result.summary.traces.recentErrors.length} recent error(s)`)
    UI.println(`  Mirror files: ${result.summary.traces.files.length}`)
    UI.println(`  Pending sessions: ${result.summary.sessions.pendingReply.length}`)
    UI.println(`  Active processes: ${result.summary.processes.active.length}`)
  },
})

function parseDuration(input: string) {
  const match = input.trim().match(/^(\d+)(ms|s|m|h|d)?$/)
  if (!match) return undefined
  const value = Number(match[1])
  const unit = match[2] ?? "ms"
  const scale = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000
  return Date.now() - value * scale
}
