import { runMigrations } from "../migration"
import { Server } from "./server"
import { UI } from "../cli/ui"
import { Installation } from "../global/installation"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import { ProcessRegistry } from "../process/registry"
import { Log } from "../util/log"
import { InstanceBootstrap, ChannelBootstrap, HolosBootstrap } from "../project/bootstrap"
import * as ChannelTypes from "../channel/types"
import { Provider } from "../provider/provider"
import { DaemonLogRotate } from "../daemon/log-rotate"
import { EOL } from "os"
import { Hosted } from "./hosted"

const log = Log.create({ service: "server-runtime" })

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

export async function run(options: RuntimeOptions) {
  await runMigrations()

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

  if (!Hosted.disableWebMount()) {
    Server.mountApp()
  }
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
