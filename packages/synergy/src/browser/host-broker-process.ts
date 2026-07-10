import path from "node:path"
import { BunProc } from "../util/bun.js"
import { Log } from "../util/log"
import { BrowserBroker } from "./broker.js"
import type { BrowserOwner } from "./owner.js"
import { BrowserInstall } from "./install.js"
import { Installation } from "../global/installation.js"
import { redactBrowserText, type BrowserHostStatus } from "@ericsanchezok/synergy-browser"

export namespace BrowserHostBrokerProcess {
  export interface EnsureInput {
    owner: BrowserOwner.Info
    serverUrl: string
    routeDirectory: string
  }

  export type EnsureResult = { status: "disabled" | "running" | "started" | "failed"; key: string }
  type HostSubprocess = Bun.Subprocess<"ignore", "ignore" | "pipe", "ignore" | "pipe">

  const log = Log.create({ service: "browser.host.process" })
  let proc: HostSubprocess | null = null
  let serverUrl: string | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let activityInstalled = false
  let activityUnsubscribe: (() => void) | null = null
  let hostStatus: BrowserHostStatus = "idle"

  export function key(): string {
    return "browser-host-broker"
  }

  export function enabled(): boolean {
    const configured = process.env.SYNERGY_BROWSER_HOST_AUTOSTART?.trim().toLowerCase()
    return configured !== "0" && configured !== "false"
  }

  export function status(): BrowserHostStatus {
    if (BrowserBroker.ready("webrtc")) return "ready"
    if (!enabled()) return "unavailable"
    return hostStatus
  }

  export async function ensure(input: EnsureInput): Promise<EnsureResult> {
    installActivityListener()
    cancelIdleStop()
    BrowserBroker.prepare(input.owner, input.routeDirectory, "webrtc")
    if (BrowserBroker.ready("webrtc")) {
      hostStatus = "ready"
      return { status: "running", key: key() }
    }
    if (!enabled()) {
      hostStatus = "unavailable"
      BrowserBroker.publishHostStatus(hostStatus)
      return { status: "disabled", key: key() }
    }
    if (proc?.exitCode === null) {
      if (serverUrl !== input.serverUrl) {
        hostStatus = "failed"
        BrowserBroker.publishHostStatus(hostStatus)
        return { status: "failed", key: key() }
      }
      hostStatus = "starting"
      BrowserBroker.publishHostStatus(hostStatus)
      return { status: "running", key: key() }
    }

    serverUrl = input.serverUrl
    const pipeLogs = process.env.NODE_ENV !== "production"
    hostStatus =
      Installation.VERSION === "local" || process.env.SYNERGY_BROWSER_HOST_COMMAND ? "starting" : "installing"
    BrowserBroker.publishHostStatus(hostStatus)
    let hostCommand: string[]
    try {
      hostCommand = await command()
    } catch (error) {
      hostStatus = "failed"
      BrowserBroker.publishHostStatus(hostStatus)
      log.error("browser.host.install.failed", { error })
      throw error
    }
    hostStatus = "starting"
    BrowserBroker.publishHostStatus(hostStatus)
    proc = Bun.spawn(hostCommand, {
      cwd: repoRoot(),
      detached: process.platform !== "win32",
      stdout: pipeLogs ? "pipe" : "ignore",
      stderr: pipeLogs ? "pipe" : "ignore",
      env: {
        ...process.env,
        SYNERGY_BROWSER_HOST_SERVER_URL: input.serverUrl,
        SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: BrowserBroker.secret(),
      },
    })
    const active = proc
    log.info("browser.host.broker.started", { pid: active.pid, serverUrl: input.serverUrl })
    if (pipeLogs) {
      pipe(active.stdout, "stdout")
      pipe(active.stderr, "stderr")
    }
    active.exited.finally(() => {
      if (proc !== active) return
      log.info("browser.host.broker.exited", { pid: active.pid, exitCode: active.exitCode })
      proc = null
      serverUrl = null
      hostStatus = active.exitCode === 0 ? "idle" : "failed"
      BrowserBroker.publishHostStatus(hostStatus)
    })
    return { status: "started", key: key() }
  }

  export async function stop(): Promise<void> {
    cancelIdleStop()
    const active = proc
    if (!active) return
    let exited = active.exitCode !== null
    const exit = active.exited.then(() => {
      exited = true
    })
    killHostTree(active, "SIGTERM")
    await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 5_000))])
    if (!exited) {
      killHostTree(active, "SIGKILL")
      await Promise.race([exit, new Promise<void>((resolve) => setTimeout(resolve, 2_000))])
    }
    if (!exited) throw new Error(`Browser Host process ${active.pid} did not exit after SIGKILL.`)
    if (proc === active) proc = null
    serverUrl = null
    hostStatus = "idle"
    BrowserBroker.publishHostStatus(hostStatus)
  }

  export function resetForTest(): void {
    cancelIdleStop()
    if (proc) killHostTree(proc, "SIGKILL")
    proc = null
    serverUrl = null
    hostStatus = "idle"
    activityUnsubscribe?.()
    activityUnsubscribe = null
    activityInstalled = false
  }

  function installActivityListener(): void {
    if (activityInstalled) return
    activityInstalled = true
    activityUnsubscribe = BrowserBroker.onActivity((hasPages) => {
      if (hasPages) {
        cancelIdleStop()
        return
      }
      if (!proc || idleTimer) return
      idleTimer = setTimeout(() => {
        idleTimer = null
        void stop()
      }, 60_000)
    })
  }

  function cancelIdleStop(): void {
    if (!idleTimer) return
    clearTimeout(idleTimer)
    idleTimer = null
  }

  async function command(): Promise<string[]> {
    const configured = process.env.SYNERGY_BROWSER_HOST_COMMAND
    if (configured)
      return configured.trim().startsWith("[") ? JSON.parse(configured) : configured.split(/\s+/).filter(Boolean)
    if (Installation.VERSION === "local") return [BunProc.which(), "run", "--cwd", desktopDir(), "browser-host:dev"]
    return [await BrowserInstall.ensureHost()]
  }

  function repoRoot(): string {
    return path.resolve(import.meta.dir, "../../..")
  }

  function desktopDir(): string {
    return path.resolve(import.meta.dir, "../../../desktop")
  }

  function pipe(stream: ReadableStream<Uint8Array> | null | undefined, name: string): void {
    if (!stream) return
    void (async () => {
      const reader = stream.getReader()
      const decoder = new TextDecoder()
      let buffered = ""
      const publish = (line: string) => {
        const normalized = line.trim()
        if (normalized) log.info("browser.host.broker.output", { stream: name, line: redactBrowserText(normalized) })
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffered += decoder.decode(value, { stream: true })
        const lines = buffered.split(/\r?\n/)
        buffered = lines.pop() ?? ""
        for (const line of lines) publish(line.slice(0, 64 * 1024))
        while (buffered.length > 64 * 1024) {
          publish(buffered.slice(0, 64 * 1024))
          buffered = buffered.slice(64 * 1024)
        }
      }
      buffered += decoder.decode()
      publish(buffered.slice(0, 64 * 1024))
    })()
  }

  function killHostTree(active: HostSubprocess, signal: "SIGTERM" | "SIGKILL"): void {
    if (active.exitCode !== null) return
    if (process.platform !== "win32") {
      try {
        process.kill(-active.pid, signal)
        return
      } catch {}
    }
    active.kill(signal)
  }
}
