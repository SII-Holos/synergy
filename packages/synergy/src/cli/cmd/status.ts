import { cmd } from "./cmd"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { ServerProcessLock } from "../../daemon/server-process-lock"
import { ProcessRegistry } from "../../process/registry"
import { Observability } from "../../observability"
import { UI } from "../ui"

export const StatusCommand = cmd({
  command: "status",
  describe: "show synergy background service status",
  builder: (yargs) =>
    yargs.option("verbose", {
      type: "boolean",
      default: false,
      describe: "show lock, health, trace, and local process details",
    }),
  handler: async (args) => {
    const status = await Daemon.status()
    DaemonOutput.printStatus(status)
    if (args.verbose) {
      await printVerbose(status.url)
    }
    if (status.runtime === "failed" || status.runtime === "unknown") {
      process.exitCode = 1
    }
  },
})

async function printVerbose(healthUrl: string) {
  UI.println()
  UI.println("Diagnostics")
  const lock = await ServerProcessLock.read().catch(() => undefined)
  if (!lock) {
    UI.println("  Runtime lock: none")
  } else {
    UI.println(`  Runtime lock: pid=${lock.pid} mode=${lock.mode} cwd=${lock.cwd}`)
    const inspection = await ServerProcessLock.inspect(lock, { healthUrl }).catch(() => undefined)
    if (inspection) {
      UI.println(
        `  Process: alive=${inspection.alive} healthy=${inspection.healthy ?? "unknown"} ppid=${inspection.ppid ?? "?"} cpu=${inspection.cpu ?? "?"}% elapsed=${inspection.elapsed ?? "?"}`,
      )
      if (inspection.listeningPorts?.length) {
        UI.println(`  Listening ports: ${inspection.listeningPorts.join(", ")}`)
      }
      if (inspection.command) UI.println(`  Command: ${inspection.command}`)
    }
  }

  const active = ProcessRegistry.listActive()
  const finished = ProcessRegistry.listFinished()
  UI.println(`  Local active processes: ${active.length}`)
  UI.println(`  Local finished processes: ${finished.length}`)

  const recentErrors = (await Observability.query({ limit: 100 })).filter(
    (event) => event.level === "error" || event.type.endsWith(".error") || event.type.includes("error"),
  )
  UI.println(`  Trace dir: ${Observability.dir()}`)
  UI.println(`  Recent trace errors: ${recentErrors.length}`)
}
