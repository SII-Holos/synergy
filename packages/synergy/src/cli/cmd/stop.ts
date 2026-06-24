import { cmd } from "./cmd"
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
        DaemonOutput.printNoService({ activeUrl: status.url })
        process.exit(1)
      }
      DaemonOutput.printNoService()
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

    DaemonOutput.printStopSuccess({ portStopped, url: spec.url })
  },
})
