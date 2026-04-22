import { cmd } from "./cmd"
import { withNetworkOptions } from "../network"
import { UI } from "../ui"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonService } from "../../daemon/service"
import { getDevWatchdogPidFile } from "../../server/runtime"

async function isWatchdogRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function verifyWatchdogIdentity(pid: number, startTime: number): Promise<boolean> {
  // Verify the process at `pid` started around the same time as recorded
  // in the PID file. This prevents signaling the wrong process if the PID
  // was reused after the original watchdog exited.
  try {
    const fs = await import("fs/promises")
    if (process.platform === "linux") {
      // On Linux, read /proc/<pid>/stat to get the process start time in jiffies
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8")
      // Field 22 is starttime (jiffies since boot)
      const fields = stat.split(" ")
      const startTimeJiffies = parseInt(fields[21], 10)
      if (isNaN(startTimeJiffies)) return false
      // Read boot time in jiffies from /proc/stat
      const procStat = await fs.readFile("/proc/stat", "utf-8")
      const btimeMatch = procStat.match(/btime\s+(\d+)/)
      if (!btimeMatch) return false
      const bootTimeSec = parseInt(btimeMatch[1], 10)
      const clockTicks = 100 // CLK_TCK on Linux, typically 100
      const procStartSec = bootTimeSec + startTimeJiffies / clockTicks
      const procStartMs = procStartSec * 1000
      // Allow 2s tolerance for timing differences
      return Math.abs(procStartMs - startTime) < 2000
    }
    // On non-Linux, fall back to just checking if the process exists
    // PID reuse is rare on macOS and in dev mode the risk is acceptable
    return isWatchdogRunning(pid)
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
    const cwd = process.env.SYNERGY_CWD ?? process.cwd()
    const pidFile = getDevWatchdogPidFile(cwd)
    try {
      const content = await Bun.file(pidFile).text()
      let pid: number
      let startTime: number | undefined

      // Parse PID file — may be JSON with identity token or plain PID (legacy)
      try {
        const data = JSON.parse(content)
        pid = parseInt(String(data.pid), 10)
        startTime = data.startTime
      } catch {
        pid = parseInt(content.trim(), 10)
      }

      if (!isNaN(pid)) {
        const isRunning = await isWatchdogRunning(pid)
        if (!isRunning) {
          UI.error(`PID ${pid} in dev-watchdog.pid is not running. Removing stale PID file.`)
          try {
            await Bun.file(pidFile).unlink()
          } catch {}
          // Fall through to daemon restart
        } else if (startTime && !(await verifyWatchdogIdentity(pid, startTime))) {
          UI.error(`PID ${pid} in dev-watchdog.pid belongs to a different process. Removing stale PID file.`)
          try {
            await Bun.file(pidFile).unlink()
          } catch {}
          // Fall through to daemon restart
        } else {
          try {
            process.kill(pid, "SIGUSR1")
            UI.println(`Restarted dev server (watchdog PID ${pid}).`)
            return
          } catch (error) {
            UI.error(`Dev server (PID ${pid}) is not running. Removing stale PID file.`)
            try {
              await Bun.file(pidFile).unlink()
            } catch {}
            // Fall through to daemon restart instead of exiting
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
