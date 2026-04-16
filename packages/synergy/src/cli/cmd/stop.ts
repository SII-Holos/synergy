import { cmd } from "./cmd"
import { UI } from "../ui"
import { Daemon } from "../../daemon"
import { DaemonHealth } from "../../daemon/health"
import { DaemonOutput } from "../../daemon/output"

export const StopCommand = cmd({
  command: "stop",
  describe: "stop synergy background service",
  handler: async () => {
    const status = await Daemon.status()
    if (!status.installed) {
      if (status.runtime === "unknown") {
        UI.error("No managed Synergy background service is installed")
        UI.println("  Observed:  the configured address is still active")
        UI.println("  URL:       " + status.url)
        UI.println()
        UI.println("  Next:")
        UI.println("    Stop the other process using this address, or change Synergy's server port")
        UI.println("    synergy status")
        process.exit(1)
      }
      UI.println("No Synergy background service is installed")
      UI.println()
      UI.println("  Next:")
      UI.println("    synergy start")
      return
    }

    const { spec } = await Daemon.stop()
    const result = await Daemon.waitForStopped()
    const portStopped = await DaemonHealth.waitForPortToStop(spec.port, spec.connectHostname)
    if (!result.ok) {
      DaemonOutput.printStopFailure({
        message: "Synergy background service stop did not complete in time",
        runtime: result.state.runtime,
        url: result.state.url,
        logFile: result.state.logFile,
        detail: result.state.detail,
        notes:
          result.state.runtime === "unknown"
            ? ["The service manager reports stopped state differently from the observed address state."]
            : undefined,
      })
      process.exit(1)
    }

    UI.println("Synergy background service stopped")
    UI.println()
    UI.println("  Next:")
    UI.println("    synergy start")
    UI.println("    synergy status")
    if (!portStopped) {
      UI.println()
      UI.println(
        UI.Style.TEXT_DIM +
          "  Note: the configured address is still active, which may indicate another process is listening there" +
          UI.Style.TEXT_NORMAL,
      )
      UI.println(UI.Style.TEXT_DIM + "  URL:   ", UI.Style.TEXT_NORMAL, spec.url)
    }
  },
})
