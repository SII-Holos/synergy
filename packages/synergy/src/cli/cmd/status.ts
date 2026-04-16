import { cmd } from "./cmd"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"

export const StatusCommand = cmd({
  command: "status",
  describe: "show synergy background service status",
  handler: async () => {
    const status = await Daemon.status()
    DaemonOutput.printStatus(status)
    if (status.runtime === "failed" || status.runtime === "unknown") {
      process.exitCode = 1
    }
  },
})
