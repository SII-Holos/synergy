import { cmd } from "./cmd"
import { withNetworkOptions } from "../network"
import { UI } from "../ui"
import { Daemon } from "../../daemon"
import { DaemonOutput } from "../../daemon/output"
import { DaemonService } from "../../daemon/service"
import { getDevWatchdogPidFile, getDevRestartFlagFile } from "../../server/runtime"
import { parseProcStatStarttime } from "../../util/proc"

/**
 * Parse BSD/macOS `ps -o etime=` output into total seconds.
 * Format: "[[dd-]hh:]mm:ss" e.g. "1-03:45:22" or "12:34" or "1:23:45"
 */
function parseEtime(etime: string): number | undefined {
  const trimmed = etime.trim()
  // Split on colons and dashes to get [days,] [hours,] minutes, seconds
  const dashParts = trimmed.split("-")
  let days = 0
  let timeStr = trimmed
  if (dashParts.length === 2) {
    days = parseInt(dashParts[0], 10)
    timeStr = dashParts[1]
  }
  const parts = timeStr.split(":").map((p) => parseInt(p, 10))
  if (parts.some((p) => isNaN(p))) return undefined
  let seconds = 0
  if (parts.length === 3) {
    // hh:mm:ss
    seconds = parts[0] * 3600 + parts[1] * 60 + parts[2]
  } else if (parts.length === 2) {
    // mm:ss
    seconds = parts[0] * 60 + parts[1]
  } else {
    return undefined
  }
  return days * 86400 + seconds
}

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
          // macOS: use ps -o etime= to get elapsed time since process start.
          // BSD ps uses "etime" (not "etimes" which is Linux-only).
          // Format: [[dd-]hh:]mm:ss — always locale-independent.
          const { execSync } = await import("child_process")
          try {
            const etime = execSync(`ps -p ${pid} -o etime= 2>/dev/null`, { encoding: "utf-8" }).trim()
            if (!etime) return false
            const elapsedSec = parseEtime(etime)
            if (elapsedSec === undefined) return false
            // Verify: stored startTime + elapsed ≈ now (allow 2s tolerance)
            const expectedNow = Math.floor(startTime / 1000) + elapsedSec
            const actualNow = Math.floor(Date.now() / 1000)
            return Math.abs(actualNow - expectedNow) <= 2
          } catch {
            return false
          }
        } else if (process.platform === "win32") {
          // Windows: check process start time via wmic or PowerShell fallback
          if (startTime !== undefined) {
            const { execSync: execWin } = await import("child_process")
            let procStart: number | undefined
            try {
              // Try wmic first (available on older Windows)
              const creationDate = execWin(`wmic process where processid=${pid} get CreationDate /value 2>nul`, {
                encoding: "utf-8",
              }).trim()
              if (creationDate && creationDate.includes("=")) {
                const dateStr = creationDate.split("=")[1]?.trim()
                if (dateStr) {
                  const match = dateStr.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
                  if (match) {
                    procStart = Math.floor(
                      new Date(+match[1], +match[2] - 1, +match[3], +match[4], +match[5], +match[6]).getTime() / 1000,
                    )
                  }
                }
              }
              // If wmic returned empty/unparsable output, fall through to PowerShell
            } catch {
              // wmic not available (deprecated on newer Windows) — fall through to PowerShell
            }
            // Try PowerShell if wmic didn't produce a valid procStart
            // Use elapsed seconds (locale-independent) instead of parsing StartTime
            if (procStart === undefined) {
              try {
                const psOutput = execWin(
                  `powershell -NoProfile -Command "try { (Get-Process -Id ${pid}).StartTime | Get-Date -UFormat '%s' } catch {}" 2>nul`,
                  { encoding: "utf-8" },
                ).trim()
                if (psOutput) {
                  const psEpoch = parseInt(psOutput, 10)
                  if (!isNaN(psEpoch)) {
                    const storedStart = Math.floor(startTime / 1000)
                    if (Math.abs(psEpoch - storedStart) <= 2) {
                      procStart = storedStart // mark as verified
                    }
                  }
                }
              } catch {
                // PowerShell also failed
              }
            }
            if (procStart !== undefined) {
              const storedStart = Math.floor(startTime / 1000)
              return Math.abs(procStart - storedStart) <= 2
            }
          }
          // Couldn't verify identity via wmic or PowerShell — fail closed
          // rather than accepting any process with this PID
          return false
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
        // Legacy plain-PID format — no identity token available.
        // Without startTime, we can't verify the PID belongs to the watchdog,
        // so refuse to signal it (PID reuse risk).
        pid = parseInt(content.trim(), 10)
        UI.error("PID file uses legacy format (no identity token). Cannot verify process identity.")
        UI.error("Restart the dev server to generate a new PID file.")
        try {
          await Bun.file(pidFile).unlink()
        } catch {}
        process.exit(1)
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
          if (process.env.SYNERGY_CWD) {
            UI.error("No dev watchdog server is running. Start one with: bun dev server")
            process.exit(1)
          }
          // Fall through to daemon restart
        } else if (startTime !== undefined && !(await verifyWatchdogIdentity(pid, startTime, starttimeJiffies))) {
          UI.error(`PID ${pid} in dev-watchdog.pid belongs to a different process. Removing stale PID file.`)
          try {
            await Bun.file(pidFile).unlink()
          } catch {}
          if (process.env.SYNERGY_CWD) {
            UI.error("No dev watchdog server is running. Start one with: bun dev server")
            process.exit(1)
          }
          // Fall through to daemon restart
        } else {
          try {
            if (process.platform === "win32") {
              // On Windows, SIGUSR1 is not available. Use a flag file
              // that the watchdog polls to trigger a restart.
              const flagFile = getDevRestartFlagFile(effectiveCwd)
              await Bun.write(flagFile, String(Date.now()))
              // Wait up to 35s for the watchdog to consume the flag file.
              // The watchdog polls every 1s, but after a crash it may be in
              // backoff sleep (up to 30s). A 35s timeout covers the worst case.
              let consumed = false
              for (let i = 0; i < 350; i++) {
                await Bun.sleep(100)
                if (!(await Bun.file(flagFile).exists())) {
                  consumed = true
                  break
                }
              }
              if (consumed) {
                UI.println(`Restarted dev server (watchdog PID ${pid}).`)
              } else {
                UI.error(`Restart flag was not consumed by watchdog (PID ${pid}). The server may have exited.`)
                try {
                  await Bun.file(flagFile).unlink()
                } catch {}
                process.exit(1)
              }
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
            if (process.env.SYNERGY_CWD) {
              UI.error("No dev watchdog server is running. Start one with: bun dev server")
              process.exit(1)
            }
            // Fall through to daemon restart instead of exiting
          }
        }
      }
    } catch {
      // No PID file at all.
      if (process.env.SYNERGY_CWD) {
        // Dev mode but no PID file — the watchdog PID write may have failed,
        // or the dev server was never started. Warn but fall through to daemon
        // since we can't know for sure.
        UI.error("Warning: no dev watchdog PID file found. Falling back to daemon restart.")
        UI.error("If the dev server is running but the PID file was lost, restart it manually.")
      }
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
