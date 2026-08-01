import path from "node:path"
import { BunProc } from "../util/bun.js"
import { Log } from "../util/log"
import { BrowserBroker } from "./broker.js"
import type { BrowserOwner } from "./owner.js"
import { BrowserInstall } from "./install.js"
import { Installation } from "../global/installation.js"
import { redactBrowserText, type BrowserHostStatus } from "@ericsanchezok/synergy-browser"
import { ProcessInspection } from "../process/inspection.js"

export namespace BrowserHostBrokerProcess {
  export interface EnsureInput {
    owner: BrowserOwner.Info
    serverUrl: string
    routeDirectory: string
  }

  export type EnsureResult = { status: "disabled" | "running" | "started"; key: string }
  type HostSubprocess = Bun.Subprocess<"ignore", "ignore" | "pipe", "ignore" | "pipe">

  const log = Log.create({ service: "browser.host.process" })
  let proc: HostSubprocess | null = null
  let serverUrl: string | null = null
  let listenUrl: string | null = null
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let activityInstalled = false
  let activityUnsubscribe: (() => void) | null = null
  let hostStatus: BrowserHostStatus = "idle"
  let baselineRssBytes: number | undefined
  let peakRssBytes = 0
  let currentRssBytes: number | undefined
  let ensureChain: Promise<EnsureResult> | null = null
  let launchServerUrl: string | null = null
  let launchEpoch = 0
  let lastRecovery:
    | {
        action: "idle_retire"
        reason: "no_active_pages"
        at: number
        beforeBytes?: number
        afterBytes: number
        reclaimedBytes?: number
      }
    | undefined

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

  export function resourceStats() {
    const active = proc?.exitCode === null ? proc : undefined
    if (active) {
      const sample = ProcessInspection.rssBytes(active.pid)
      if (sample !== undefined) {
        currentRssBytes = sample
        baselineRssBytes = baselineRssBytes === undefined ? sample : Math.min(baselineRssBytes, sample)
        peakRssBytes = Math.max(peakRssBytes, sample)
      }
    } else {
      currentRssBytes = undefined
    }
    return {
      processCount: active ? 1 : 0,
      measuredProcessCount: active && currentRssBytes !== undefined ? 1 : 0,
      currentBytes: currentRssBytes,
      baselineBytes: baselineRssBytes,
      peakBytes: peakRssBytes || undefined,
      retainedBytes:
        currentRssBytes === undefined
          ? undefined
          : Math.max(0, currentRssBytes - (baselineRssBytes ?? currentRssBytes)),
      lastRecovery,
    }
  }

  export function configureServerUrl(url: string): void {
    listenUrl = url
  }

  export function activeServerUrl(): string | null {
    return serverUrl
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

    const resolvedServerUrl = resolveServerUrl(input.serverUrl)
    if (ensureChain) {
      if (launchServerUrl === resolvedServerUrl) {
        hostStatus = "starting"
        BrowserBroker.publishHostStatus(hostStatus)
        return { status: "running", key: key() }
      }
      // The URL differs from the in-flight launch/restart. Wait for it to
      // settle, then re-evaluate so the process is restarted with the new URL.
      const previous = ensureChain
      const run = previous.then(
        () => ensureSettled(input, resolvedServerUrl),
        () => ensureSettled(input, resolvedServerUrl),
      )
      const tail = run.finally(() => {
        if (ensureChain === tail) ensureChain = null
      })
      ensureChain = tail
      void tail.catch(() => undefined)
      return tail
    }

    if (proc?.exitCode === null && launchServerUrl === resolvedServerUrl) {
      hostStatus = "starting"
      BrowserBroker.publishHostStatus(hostStatus)
      return { status: "running", key: key() }
    }
    if (proc?.exitCode === null) {
      log.info("browser.host.broker.restarting", { previous: launchServerUrl, next: resolvedServerUrl })
      serverUrl = resolvedServerUrl
      launchServerUrl = resolvedServerUrl
      const pipeLogs = process.env.NODE_ENV !== "production"
      // A live process implies the executable is already installed, so the
      // restart is bounded (stop + spawn) and can be awaited by the caller.
      const restart = (async () => {
        await stop("restart")
        return launch(resolvedServerUrl, pipeLogs)
      })()
      const tail = restart.finally(() => {
        if (ensureChain === tail) ensureChain = null
      })
      ensureChain = tail
      void tail.catch(() => undefined)
      return tail
    }

    serverUrl = resolvedServerUrl
    return startLaunch(resolvedServerUrl)
  }

  function startLaunch(resolvedServerUrl: string): EnsureResult {
    const pipeLogs = process.env.NODE_ENV !== "production"
    hostStatus =
      Installation.VERSION === "local" || process.env.SYNERGY_BROWSER_HOST_COMMAND ? "starting" : "installing"
    BrowserBroker.publishHostStatus(hostStatus)
    launchServerUrl = resolvedServerUrl
    // Resolve the command (including any managed installation) and spawn in the
    // background so the HTTP control request is never blocked by a multi-minute
    // download. Callers get a bounded wait (browser_host_pending) and retry.
    ensureChain = launch(resolvedServerUrl, pipeLogs).finally(() => {
      ensureChain = null
    })
    void ensureChain.catch(() => undefined)
    return { status: "started", key: key() }
  }

  async function ensureSettled(input: EnsureInput, resolvedServerUrl: string): Promise<EnsureResult> {
    if (proc?.exitCode === null) {
      if (launchServerUrl === resolvedServerUrl) {
        hostStatus = "starting"
        BrowserBroker.publishHostStatus(hostStatus)
        return { status: "running", key: key() }
      }
      log.info("browser.host.broker.restarting", { previous: launchServerUrl, next: resolvedServerUrl })
      serverUrl = resolvedServerUrl
      launchServerUrl = resolvedServerUrl
      const pipeLogs = process.env.NODE_ENV !== "production"
      await stop("restart")
      return launch(resolvedServerUrl, pipeLogs)
    }
    serverUrl = resolvedServerUrl
    return startLaunch(resolvedServerUrl)
  }

  async function launch(resolvedServerUrl: string, pipeLogs: boolean): Promise<EnsureResult> {
    const epoch = ++launchEpoch
    const hostCommand = await command().catch((error) => {
      if (launchEpoch !== epoch) return null
      hostStatus = "failed"
      BrowserBroker.publishHostStatus(hostStatus)
      log.error("browser.host.install.failed", { error })
      throw error
    })
    if (hostCommand === null || launchEpoch !== epoch) return { status: "running", key: key() }

    // Re-assert the URL: the previous process's exit handler clears serverUrl
    // when it observes the old process exiting during a restart.
    serverUrl = resolvedServerUrl
    hostStatus = "starting"
    BrowserBroker.publishHostStatus(hostStatus)
    const active = Bun.spawn(hostCommand, {
      cwd: repoRoot(),
      detached: process.platform !== "win32",
      stdout: pipeLogs ? "pipe" : "ignore",
      stderr: pipeLogs ? "pipe" : "ignore",
      env: {
        ...process.env,
        SYNERGY_BROWSER_HOST_SERVER_URL: resolvedServerUrl,
        SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: BrowserBroker.secret(),
      },
    })
    proc = active
    log.info("browser.host.broker.started", { pid: active.pid, serverUrl: resolvedServerUrl })
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

  export async function stop(reason: "shutdown" | "idle_no_pages" | "restart" = "shutdown"): Promise<void> {
    cancelIdleStop()
    launchEpoch++
    const active = proc
    if (!active) return
    const beforeBytes = ProcessInspection.rssBytes(active.pid) ?? currentRssBytes
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
    if (reason !== "restart") serverUrl = null
    hostStatus = reason === "restart" ? "restarting" : "idle"
    BrowserBroker.publishHostStatus(hostStatus)
    currentRssBytes = undefined
    if (reason === "idle_no_pages") {
      lastRecovery = {
        action: "idle_retire",
        reason: "no_active_pages",
        at: Date.now(),
        beforeBytes,
        afterBytes: 0,
        reclaimedBytes: beforeBytes,
      }
    }
  }

  export function resetForTest(): void {
    cancelIdleStop()
    if (proc) killHostTree(proc, "SIGKILL")
    proc = null
    serverUrl = null
    listenUrl = null
    hostStatus = "idle"
    baselineRssBytes = undefined
    peakRssBytes = 0
    currentRssBytes = undefined
    lastRecovery = undefined
    ensureChain = null
    launchServerUrl = null
    launchEpoch++
    activityUnsubscribe?.()
    activityUnsubscribe = null
    activityInstalled = false
  }

  function resolveServerUrl(requestOrigin: string): string {
    const configured = process.env.SYNERGY_BROWSER_HOST_SERVER_URL?.trim()
    if (configured) {
      try {
        const parsed = new URL(configured)
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin
      } catch {}
      log.warn("browser.host.broker.invalid_server_url_override", { value: configured })
    }
    if (!listenUrl) return requestOrigin
    try {
      const url = new URL(listenUrl)
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
      else if (url.hostname === "[::]") url.hostname = "[::1]"
      return url.origin
    } catch {
      return requestOrigin
    }
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
        void stop("idle_no_pages")
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
