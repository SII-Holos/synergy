import { cmd } from "./cmd"
import { withNetworkOptions } from "../network"
import { UI } from "../ui"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonService } from "../../daemon/service"
import { DevWatchdogPidFile } from "../../server/runtime"

/**
 * Verify that a PID is actually our dev watchdog process.
 * On Unix, checks that the process command matches synergy/bun running our server.
 * On Windows, just checks if the process exists.
 */
async function verifyWatchdogPid(pid: number): Promise<boolean> {
  try {
    // On Unix, we can check the process command
    if (process.platform !== "win32") {
      const { exec } = await import("child_process")
      const psCmd = `ps -p ${pid} -o comm= 2>/dev/null`
      const comm = await new Promise<string>((resolve) => {
        exec(psCmd, (error, stdout) => {
          resolve(error ? "" : stdout.trim())
        })
      })
      // Check if it's bun/node running synergy
      if (comm.includes("bun") || comm.includes("node") || comm.includes("synergy")) {
        return true
      }
      // Process exists but doesn't look like our watchdog
      return false
    }
    // On Windows, just check if process exists
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const RestartCommand = cmd({
  command: "restart",
  describe: "restart synergy server",
  builder: (yargs) => withNetworkOptions(yargs),
  handler: async () => {
    // If a dev-mode watchdog PID file exists, signal it.
    try {
      const content = await Bun.file(DevWatchdogPidFile).text()
      const pid = parseInt(content.trim(), 10)
      if (!isNaN(pid)) {
        // Verify the PID is actually our watchdog process
        const isValid = await verifyWatchdogPid(pid)
        if (!isValid) {
          UI.error(`PID ${pid} in dev-watchdog.pid is not a valid watchdog process. Removing stale PID file.`)
          try {
            await Bun.file(DevWatchdogPidFile).unlink()
          } catch {}
          // Fall through to daemon restart
        } else {
          try {
            process.kill(pid, "SIGHUP")
            UI.println(`Restarted dev server (watchdog PID ${pid}).`)
            return
          } catch (error) {
            UI.error(`Dev server (PID ${pid}) is not running. Removing stale PID file.`)
            try {
              await Bun.file(DevWatchdogPidFile).unlink()
            } catch {}
            process.exit(1)
          }
        }
      }
    } catch {
      // No PID file — fall through to daemon restart.
    }

    // Restart the managed background service.
    let service: Awaited<ReturnType<typeof Daemon.restart>>["service"]
    try {
      const restarted = await Daemon.restart()
      service = restarted.service
    } catch (error) {
      const [spec, resolvedService] = await Promise.all([
        Daemon.buildSpec().catch(() => undefined),
        DaemonService.resolve().catch(() => undefined),
      ])
      DaemonOutput.printStartFailure({
        message: `Failed to restart the background service: ${error instanceof Error ? error.message : String(error)}`,
        manager: resolvedService?.manager ?? "schtasks",
        url: spec?.url ?? "unknown",
        logFile: spec?.logFile ?? "unknown",
      })
      process.exit(1)
    }
    const result = await Daemon.waitForRunning()
    if (!result.ok) {
      DaemonOutput.printStartFailure({
        message: "Synergy background service did not become ready after restart",
        manager: service.manager,
        runtime: result.state.runtime,
        url: result.state.url,
        logFile: result.state.logFile,
        detail: result.state.detail,
        notes:
          result.state.runtime === "failed"
            ? ["The service restarted under the manager, but the server did not pass health checks."]
            : result.state.runtime === "unknown"
              ? ["The service manager and observed network state do not agree yet."]
              : undefined,
      })
      process.exit(1)
    }

    DaemonOutput.printServiceSummary({
      title: "Synergy background service restarted",
      manager: service.manager,
      url: result.state.url,
      logFile: result.state.logFile,
      detail: result.state.detail,
      next: ["synergy status", "synergy web", 'synergy send "your message"'],
    })
  },
})
