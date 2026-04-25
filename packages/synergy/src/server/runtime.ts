import { ensureMigrations } from "../migration"
import { Server } from "./server"
import { UI } from "../cli/ui"
import { Installation } from "../global/installation"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import { ProcessRegistry } from "../process/registry"
import { Log } from "../util/log"
import { parseProcStatStarttime } from "../util/proc"
import { InstanceBootstrap, ChannelBootstrap, HolosBootstrap } from "../project/bootstrap"
import * as ChannelTypes from "../channel/types"
import { Provider } from "../provider/provider"
import { DaemonLogRotate } from "../daemon/log-rotate"
import { SingleInstance } from "../daemon/single-instance"
import { EOL } from "os"
import path from "path"
import crypto from "crypto"
import { Global } from "../global"

const log = Log.create({ service: "server-runtime" })

/**
 * Minimal watchdog child spawner for --restart=always.
 * Responsibilities:
 *  - Add --restart=none to child argv (overrides any previous --restart)
 *  - Spawn child process
 *  - Forward SIGINT/SIGTERM to child
 *  - When child exits:
 *    - If shutdown was requested via signal -> exit wrapper
 *    - Otherwise -> automatically respawn with crash backoff
 */
async function runWithRestartPolicyAlways(options: RuntimeOptions): Promise<never> {
  const originalArgv = process.argv.slice(1)

  // Add --restart=none to override any --restart in original argv (yargs honors last value)
  const childArgv = [...originalArgv, "--restart=none"]

  // Preserve the parent process's working directory at startup time.
  // This ensures that respawned children resolve relative script paths
  // (such as src/index.ts in source/dev mode) from the same directory
  // as the parent, regardless of SYNERGY_CWD or later chdir() calls.
  const parentCwd = process.cwd()

  let shuttingDown = false
  let devRestartRequested = false
  let crashCount = 0
  let abortController = new AbortController()
  const crashStartTime: number[] = []

  const isDev = options.restartPolicy === "dev"
  const log = Log.create({ service: isDev ? "server-dev-watchdog" : "server-watchdog" })

  // In dev mode, write the watchdog PID so `synergy restart` can signal us
  // Scope the PID file by working directory to support multiple dev servers
  // Use SYNERGY_CWD to match the directory used by the restart command
  const devCwd = process.env.SYNERGY_CWD ?? parentCwd
  const cwdHash = crypto.createHash("sha256").update(devCwd).digest("hex").slice(0, 12)
  const devPidFile = isDev ? path.join(Global.Path.state, `dev-watchdog-${cwdHash}.pid`) : undefined
  // On Windows, a flag file is used instead of SIGUSR1 for restart triggering
  const devRestartFlag = isDev ? path.join(Global.Path.state, `dev-restart-${cwdHash}.flag`) : undefined
  if (devPidFile) {
    try {
      const { mkdir } = await import("fs/promises")
      await mkdir(path.dirname(devPidFile), { recursive: true })
      // Store PID + startup identity for verification.
      // On Linux, include the starttime jiffies from /proc/self/stat so
      // restart.ts can verify the process identity without knowing CLK_TCK.
      let identity: Record<string, unknown> = { pid: process.pid, startTime: Date.now(), devCwd }
      if (process.platform === "linux") {
        try {
          const selfStat = await Bun.file("/proc/self/stat").text()
          const starttime = parseProcStatStarttime(selfStat)
          if (starttime !== undefined) identity.starttimeJiffies = starttime
        } catch {}
      }
      await Bun.write(devPidFile, JSON.stringify(identity))
    } catch {}
  }

  let child: ReturnType<typeof Bun.spawn> | undefined

  const onWrapperSignal = async () => {
    if (shuttingDown) return
    shuttingDown = true
    log.info("received shutdown signal, forwarding to child and exiting watchdog")
    if (child) {
      try {
        child.kill()
      } catch {}
      try {
        await child.exited
      } catch {}
    }
    abortController.abort()
  }

  // In dev mode, SIGUSR1 triggers a restart (child exits, watchdog respawns it)
  // We use SIGUSR1 instead of SIGHUP because SIGHUP is also sent on terminal
  // hangup (closing the terminal), which should trigger shutdown instead.
  const onDevRestart = () => {
    if (shuttingDown) return
    devRestartRequested = true
    log.info("received SIGUSR1, restarting server")
    // Abort backoff sleep so the watchdog respawns immediately
    abortController.abort()
    if (child) {
      try {
        child.kill("SIGTERM")
      } catch {}
    }
  }

  if (isDev) {
    process.on("SIGUSR1", onDevRestart)
  }

  // Install persistent signal handlers (not removed during backoff)
  // SIGHUP is treated the same as SIGINT/SIGTERM (shutdown)
  process.on("SIGINT", () => onWrapperSignal())
  process.on("SIGTERM", () => onWrapperSignal())
  process.on("SIGHUP", () => onWrapperSignal())

  for (;;) {
    child = Bun.spawn({
      cmd: [process.argv0, ...childArgv],
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      cwd: parentCwd,
      env: {
        ...process.env,
        SYNERGY_RESTART_POLICY: options.restartPolicy!,
      },
    })

    const childStartTime = Date.now()

    // Poll for restart flag file while child is running.
    // This is the primary restart mechanism on Windows (no SIGUSR1),
    // and acts as a fallback on all platforms.
    const currentChild = child
    let restartPoller: ReturnType<typeof setInterval> | undefined
    if (devRestartFlag && currentChild) {
      restartPoller = setInterval(async () => {
        try {
          if (await Bun.file(devRestartFlag).exists()) {
            devRestartRequested = true
            try {
              await Bun.file(devRestartFlag).unlink()
            } catch {}
            log.info("restart flag detected, killing child for restart")
            currentChild.kill()
            clearInterval(restartPoller)
          }
        } catch {}
      }, 1000)
    }

    // Wait for child
    const exitStatus = await child.exited

    // Clean up the restart poller
    if (restartPoller !== undefined) clearInterval(restartPoller)

    // Intentional dev restarts should not count as crashes
    if (devRestartRequested) {
      devRestartRequested = false
      abortController = new AbortController()
      log.info("child exited due to dev restart, respawning immediately", {
        exitCode: exitStatus,
      })
      if (shuttingDown) {
        if (devPidFile) {
          try {
            await Bun.file(devPidFile).unlink()
          } catch {}
        }
        process.exit(0)
      }
      continue
    }

    // Track crash time for backoff calculation
    crashStartTime.push(childStartTime)

    // Keep only crashes from last 30 seconds for rapid crash counting
    const thirtySecondsAgo = Date.now() - 30000
    while (crashStartTime.length > 0 && crashStartTime[0] < thirtySecondsAgo) {
      crashStartTime.shift()
    }

    // Count rapid crashes (those that didn't run for at least 30s)
    crashCount = 0
    for (let i = 0; i < crashStartTime.length; i++) {
      crashCount++
    }

    // Decide whether to respawn
    if (shuttingDown) {
      log.info("child exited after shutdown signal, watchdog stopping")
      if (devPidFile) {
        try {
          await Bun.file(devPidFile).unlink()
        } catch {}
      }
      process.exit(0)
    }

    // Apply crash backoff logic
    if (crashCount >= 5) {
      log.error(`child crashed ${crashCount} times in 30s, stopping watchdog to prevent crash loop`, {
        exitCode: exitStatus,
        crashCount,
      })
      if (devPidFile) {
        try {
          await Bun.file(devPidFile).unlink()
        } catch {}
      }
      process.exit(1)
    }

    // Calculate backoff delay: min(1000 * 2^(n-1), 30000)
    const backoffDelay = Math.min(1000 * Math.pow(2, crashCount - 1), 30000)

    log.info("child exited, scheduling respawn", {
      exitCode: exitStatus,
      crashCount,
      delayMs: backoffDelay,
    })

    // Always delay at least 1s, and apply exponential backoff for rapid crashes
    try {
      await Promise.race([
        Bun.sleep(backoffDelay),
        new Promise<void>((_, reject) => {
          if (abortController.signal.aborted) {
            reject(new DOMException("Aborted", "AbortError"))
            return
          }
          abortController.signal.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"))
          })
        }),
      ])
    } catch {
      // sleep was aborted — by shutdown or by SIGUSR1/restart flag
    }
    abortController = new AbortController()

    // If a restart was requested during backoff, skip to respawn immediately.
    // The previous child exit was caused by the restart, not a crash —
    // remove the crash entry we already pushed.
    if (devRestartRequested) {
      devRestartRequested = false
      // Undo the crash entry we pushed before the sleep
      if (crashStartTime.length > 0 && crashStartTime[crashStartTime.length - 1] === childStartTime) {
        crashStartTime.pop()
      }
      log.info("restart requested during backoff, respawning immediately")
      continue
    }

    // Check for restart flag file as a fallback (e.g., flag written
    // while child was already exiting, or during backoff sleep)
    if (devRestartFlag && !shuttingDown) {
      try {
        if (await Bun.file(devRestartFlag).exists()) {
          try {
            await Bun.file(devRestartFlag).unlink()
          } catch {}
          // Undo the crash entry we pushed before the sleep
          if (crashStartTime.length > 0 && crashStartTime[crashStartTime.length - 1] === childStartTime) {
            crashStartTime.pop()
          }
          log.info("restart flag detected during backoff, respawning immediately")
          continue
        }
      } catch {}
    }

    // After aborted sleep, check if we should exit instead of respawning
    if (shuttingDown) {
      log.info("shutdown requested during backoff, stopping watchdog")
      if (devPidFile) {
        try {
          await Bun.file(devPidFile).unlink()
        } catch {}
      }
      process.exit(0)
    }

    log.info("respawning child", { crashCount, nextDelayMinMs: Math.min(1000 * Math.pow(2, crashCount), 30000) })
  }
}

const DIM = UI.Style.TEXT_DIM
const RESET = UI.Style.TEXT_NORMAL
const CYAN = UI.Style.TEXT_HIGHLIGHT
const CYAN_BOLD = UI.Style.TEXT_HIGHLIGHT_BOLD
const WARN = UI.Style.TEXT_WARNING
const GREEN = UI.Style.TEXT_SUCCESS

const CHANNEL_CONNECT_TIMEOUT = 15_000
const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
const SPINNER_INTERVAL = 80

export interface RuntimeOptions {
  restartPolicy?: "none" | "always" | "dev"
  interactive: boolean
  printBanner: boolean
  printChannelStatus: boolean
  network: {
    hostname: string
    port: number
    mdns?: boolean
    cors?: string[]
  }
}
export function getDevWatchdogPidFile(cwd?: string) {
  const hash = cwd ? crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12) : "unknown"
  return path.join(Global.Path.state, `dev-watchdog-${hash}.pid`)
}

export function getDevRestartFlagFile(cwd?: string) {
  const hash = cwd ? crypto.createHash("sha256").update(cwd).digest("hex").slice(0, 12) : "unknown"
  return path.join(Global.Path.state, `dev-restart-${hash}.flag`)
}
export async function run(options: RuntimeOptions) {
  // If user asked for a restart policy, spawn a child and act as a watchdog
  if (options.restartPolicy === "always" || options.restartPolicy === "dev") {
    return runWithRestartPolicyAlways(options)
  }

  // Normal path (unchanged)
  await SingleInstance.acquire()
  await ensureMigrations()

  // TODO: redesign CLI Holos login so it does not conflict with Web UI onboarding.
  // We intentionally skip the CLI startup entrypoint for now and keep standalone startup here.
  // try {
  //   await HolosStartup.resolveIdentity(options.interactive)
  // } catch (error) {
  //   log.warn("holos identity resolution failed, launching in standalone mode", {
  //     error: error instanceof Error ? error : new Error(String(error)),
  //     interactive: options.interactive,
  //   })
  // }

  Server.mountApp()
  const server = Server.listen(options.network)

  await Instance.provide({
    scope: Scope.global(),
    init: InstanceBootstrap,
    fn: async () => {
      await Promise.all([ChannelBootstrap(), HolosBootstrap()])
      if (options.printChannelStatus) {
        await printConnectionStatusSurfaces()
      }
    },
  })

  if (options.printBanner) {
    renderBanner(server)
    await printModelWarning()
  }

  registerShutdown(server)

  if (process.env.SYNERGY_DAEMON === "1") {
    DaemonLogRotate.start()
  }

  await new Promise(() => {})
}

function renderBanner(server: { hostname?: string; port?: number }) {
  const hostname = server.hostname || "localhost"
  const port = server.port || Server.DEFAULT_PORT
  const url = `http://${hostname}:${port}`
  const portExplicitlySet = process.argv.includes("--port")
  const fellBackToRandom = !portExplicitlySet && port !== Server.DEFAULT_PORT
  const attach = port === Server.DEFAULT_PORT ? "" : " --attach " + url

  const kw = 20
  const label = (text: string) => DIM + "  " + text + " ".repeat(Math.max(0, kw - text.length))

  const lines: string[] = []
  lines.push("")
  lines.push(UI.logo("  "))
  lines.push("")
  lines.push(label("Server") + CYAN_BOLD + url + RESET)
  lines.push(label("Version") + RESET + Installation.VERSION)
  if (fellBackToRandom) {
    lines.push(label("") + WARN + "⚠ Port " + Server.DEFAULT_PORT + " in use — fell back to " + port + RESET)
  }
  lines.push("")
  lines.push(DIM + "  Quick start" + RESET)
  lines.push(DIM + "    $ " + RESET + "synergy web" + attach)
  lines.push(DIM + "    $ " + RESET + "synergy send" + attach + ' "your message"')
  lines.push("")

  Bun.stderr.write(lines.join(EOL) + EOL)
}

async function printModelWarning() {
  try {
    const providers = await Provider.list()
    if (Object.keys(providers).length === 0) {
      const lines = [
        WARN + "  ⚠ No AI model configured" + RESET,
        DIM + "    Run " + RESET + "synergy config ui" + DIM + " to set up a provider before using Synergy" + RESET,
        "",
      ]
      Bun.stderr.write(lines.join(EOL) + EOL)
    }
  } catch {
    // Provider state not available yet — skip the warning
  }
}

function getStatusIcon(status: ChannelTypes.Status["status"]): string {
  switch (status) {
    case "connected":
      return GREEN + "●" + RESET
    case "connecting":
      return CYAN + "◌" + RESET
    case "disconnected":
      return DIM + "○" + RESET
    case "disabled":
      return DIM + "○" + RESET
    case "failed":
      return WARN + "●" + RESET
  }
}

function getStatusText(status: ChannelTypes.Status): string {
  if (status.status === "failed") return `failed: ${status.error}`
  return status.status
}

async function printStatusSection(input: {
  title: string
  statuses: Record<string, ChannelTypes.Status>
  refresh: () => Promise<Record<string, ChannelTypes.Status>>
}) {
  const entries = Object.entries(input.statuses)
  if (entries.length === 0) return

  const formatLine = (key: string, status: ChannelTypes.Status) =>
    DIM + "    " + getStatusIcon(status.status) + " " + RESET + key + " " + DIM + getStatusText(status) + RESET

  Bun.stderr.write(DIM + `  ${input.title}` + RESET + EOL)

  for (const [key, status] of entries) {
    if (status.status === "connecting") {
      let frame = 0
      const writeSpinner = () => {
        const icon = CYAN + SPINNER_FRAMES[frame % SPINNER_FRAMES.length] + RESET
        Bun.stderr.write("\r\x1b[K" + DIM + "    " + icon + " " + RESET + key + " " + DIM + "connecting" + RESET)
        frame++
      }

      writeSpinner()

      const finalStatus = await new Promise<ChannelTypes.Status>((resolve) => {
        const timeout = setTimeout(
          () => resolve({ status: "failed", error: "connection timeout" } as ChannelTypes.Status),
          CHANNEL_CONNECT_TIMEOUT,
        )
        const spin = setInterval(async () => {
          writeSpinner()
          if (frame % 4 === 0) {
            const current = await input.refresh().catch(() => ({}) as Record<string, ChannelTypes.Status>)
            const nextStatus = current[key]
            if (nextStatus && nextStatus.status !== "connecting") {
              clearInterval(spin)
              clearTimeout(timeout)
              resolve(nextStatus)
            }
          }
        }, SPINNER_INTERVAL)
      })

      Bun.stderr.write("\r\x1b[K" + formatLine(key, finalStatus) + EOL)
    } else {
      Bun.stderr.write(formatLine(key, status) + EOL)
    }
  }

  Bun.stderr.write(EOL)
}

async function printHolosStatus() {
  const { HolosRuntime } = await import("../holos/runtime")
  type HolosStatus = Awaited<ReturnType<typeof HolosRuntime.status>>

  const status = await HolosRuntime.status()
  const key = "agent network"

  const getHolosStatusText = (current: HolosStatus) => {
    if (current.status === "failed") return `failed: ${current.error}`
    return current.status
  }

  const formatLine = (current: HolosStatus) =>
    DIM + "    " + getStatusIcon(current.status) + " " + RESET + key + " " + DIM + getHolosStatusText(current) + RESET

  Bun.stderr.write(DIM + "  Holos Identity" + RESET + EOL)

  if (status.status === "connecting") {
    let frame = 0
    const writeSpinner = () => {
      const icon = CYAN + SPINNER_FRAMES[frame % SPINNER_FRAMES.length] + RESET
      Bun.stderr.write("\r\x1b[K" + DIM + "    " + icon + " " + RESET + key + " " + DIM + "connecting" + RESET)
      frame++
    }

    writeSpinner()

    const finalStatus = await new Promise<HolosStatus>((resolve) => {
      const timeout = setTimeout(
        () => resolve({ status: "failed", error: "connection timeout" }),
        CHANNEL_CONNECT_TIMEOUT,
      )
      const spin = setInterval(async () => {
        writeSpinner()
        if (frame % 4 === 0) {
          const nextStatus = await HolosRuntime.status().catch(
            (): HolosStatus => ({ status: "failed", error: "status unavailable" }),
          )
          if (nextStatus.status !== "connecting") {
            clearInterval(spin)
            clearTimeout(timeout)
            resolve(nextStatus)
          }
        }
      }, SPINNER_INTERVAL)
    })

    Bun.stderr.write("\r\x1b[K" + formatLine(finalStatus) + EOL)
  } else {
    Bun.stderr.write(formatLine(status) + EOL)
  }

  Bun.stderr.write(EOL)
}

async function printConnectionStatusSurfaces() {
  const { Bus } = await import("../bus")
  const { Channel } = await import("../channel")

  await printStatusSection({
    title: "Channel Integrations",
    statuses: await Channel.status(),
    refresh: () => Channel.status(),
  })

  await printHolosStatus()

  Bus.subscribe(Channel.Event.Connected, (event) => {
    const channel = event.properties.channelType + ":" + event.properties.accountId
    Bun.stderr.write(DIM + "    " + GREEN + "●" + RESET + " " + channel + " " + DIM + "reconnected" + RESET + EOL)
  })
  Bus.subscribe(Channel.Event.Disconnected, (event) => {
    const channel = event.properties.channelType + ":" + event.properties.accountId
    const reason = event.properties.reason ? ": " + event.properties.reason : ""
    Bun.stderr.write(
      DIM + "    " + WARN + "●" + RESET + " " + channel + " " + DIM + "disconnected" + reason + RESET + EOL,
    )
  })
}

function registerShutdown(server: { stop: (closeActiveConnections?: boolean) => Promise<void> }) {
  let shuttingDown = false

  const gracefulShutdown = async (signal: string) => {
    if (shuttingDown) {
      process.exit(1)
      return
    }

    shuttingDown = true
    log.info("received signal, shutting down gracefully", { signal })

    const forceExitTimeout = setTimeout(() => {
      log.warn("graceful shutdown timed out, forcing exit")
      process.exit(1)
    }, 5000)
    forceExitTimeout.unref()

    try {
      DaemonLogRotate.stop()
      await ProcessRegistry.killAllRunning()
      await Instance.disposeAll()
      await server.stop()
    } catch (error) {
      log.error("error during graceful shutdown", { error })
    }

    clearTimeout(forceExitTimeout)
    process.exit(0)
  }

  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"))
  process.on("SIGINT", () => gracefulShutdown("SIGINT"))
}
