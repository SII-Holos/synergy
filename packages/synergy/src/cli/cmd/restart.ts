import { cmd } from "./cmd"
import { withNetworkOptions } from "../network"
import { UI } from "../ui"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonService } from "../../daemon/service"
import { getDevWatchdogPidFile, getDevRestartFlagFile } from "../../server/runtime"
import { parseProcStatStarttime } from "../../util/proc"

async function isWatchdogRunning(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function verifyWatchdogIdentity(pid: number, startTime: number, starttimeJiffies?: number): Promise<boolean> {
  // Verify the process at `pid` is the same one that wrote the PID file.
  // This prevents signaling the wrong process if the PID was reused.
  try {
    if (process.platform === "linux" && starttimeJiffies !== undefined) {
      // Compare the starttime jiffies from /proc/<pid>/stat with the stored value.
      // If the PID was reused, the new process will have a different starttime.
      const fs = await import("fs/promises")
      const stat = await fs.readFile(`/proc/${pid}/stat`, "utf-8")
      const currentStarttime = parseProcStatStarttime(stat)
      if (currentStarttime === undefined) return false
      return currentStarttime === starttimeJiffies
    }
    // On non-Linux (macOS, Windows), use `ps` to check the process start time.
    // This is a weaker check than Linux's /proc but still catches most PID reuse.
    if (startTime !== undefined) {
      const { execSync } = await import("child_process")
      try {
        if (process.platform === "darwin") {
          // macOS: ps -p <pid> -o lstart= gives the process start time
          const lstart = execSync(`ps -p ${pid} -o lstart= 2>/dev/null`, { encoding: "utf-8" }).trim()
          if (!lstart) return false
          // Convert both times to epoch for comparison (allow 2s tolerance)
          const procStart = Math.floor(new Date(lstart).getTime() / 1000)
          const storedStart = Math.floor(startTime / 1000)
          return Math.abs(procStart - storedStart) <= 2
        } else if (process.platform === "win32") {
          // Windows: wmic can give CreationDate but it's unreliable for short-lived PIDs.
          // Fall back to existence check — PID reuse is rare on Windows.
          return isWatchdogRunning(pid)
        }
      } catch {
        return false
      }
    }
    // No startTime available — just check if the process exists
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
      let starttimeJiffies: number | undefined
      let storedCwd: string | undefined

      // Parse PID file — may be JSON with identity token or plain PID (legacy)
      try {
        const data = JSON.parse(content)
        pid = parseInt(String(data.pid), 10)
        startTime = data.startTime
        starttimeJiffies = data.starttimeJiffies
        storedCwd = data.devCwd
      } catch {
        pid = parseInt(content.trim(), 10)
      }

      // Use the stored cwd from PID file for flag file path consistency.
      // If the server was started from a different directory than restart,
      // the stored cwd ensures we write the flag file to the right location.
      const effectiveCwd = storedCwd ?? cwd

      if (!isNaN(pid)) {
        const isRunning = await isWatchdogRunning(pid)
        if (!isRunning) {
          UI.error(`PID ${pid} in dev-watchdog.pid is not running. Removing stale PID file.`)
          try {
            await Bun.file(pidFile).unlink()
          } catch {}
          // Fall through to daemon restart
        } else if (startTime !== undefined && !(await verifyWatchdogIdentity(pid, startTime, starttimeJiffies))) {
          UI.error(`PID ${pid} in dev-watchdog.pid belongs to a different process. Removing stale PID file.`)
          try {
            await Bun.file(pidFile).unlink()
          } catch {}
          // Fall through to daemon restart
        } else {
          try {
            if (process.platform === "win32") {
              // On Windows, SIGUSR1 is not available. Use a flag file
              // that the watchdog polls to trigger a restart.
              await Bun.write(getDevRestartFlagFile(effectiveCwd), String(Date.now()))
              UI.println(`Restart requested for dev server (watchdog PID ${pid}).`)
            } else {
              process.kill(pid, "SIGUSR1")
              UI.println(`Restarted dev server (watchdog PID ${pid}).`)
            }
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
