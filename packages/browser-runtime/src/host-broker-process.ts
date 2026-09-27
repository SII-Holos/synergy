import { RuntimeContext } from "@ericsanchezok/synergy-harness/lifecycle/context"
import path from "node:path"
import { BunProc } from "@ericsanchezok/synergy-harness/util/bun"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { BrowserBroker } from "./broker.js"
import type { BrowserOwner } from "./owner.js"
import { BrowserInstall } from "./install.js"
import { Installation } from "@ericsanchezok/synergy-harness/global/installation"
import { redactBrowserText, type BrowserHostStatus } from "@ericsanchezok/synergy-browser-core"
import { ProcessInspection } from "@ericsanchezok/synergy-harness/process/inspection"

export namespace BrowserHostBrokerProcess {
  export interface EnsureInput {
    owner: BrowserOwner.Info
    serverUrl: string
    routeDirectory: string
  }

  export type EnsureResult = { status: "disabled" | "running" | "started"; key: string }
  type HostSubprocess = Bun.Subprocess<"ignore", "ignore" | "pipe", "ignore" | "pipe">

  const log = Log.create({ service: "browser.host.process" })
  const runtimeState = RuntimeContext.state(() => ({
    proc: null as HostSubprocess | null,
    serverUrl: null as string | null,
    listenUrl: null as string | null,
    idleTimer: null as ReturnType<typeof setTimeout> | null,
    activityInstalled: false,
    activityUnsubscribe: null as (() => void) | null,
    hostStatus: "idle" as BrowserHostStatus,
    baselineRssBytes: undefined as number | undefined,
    peakRssBytes: 0,
    currentRssBytes: undefined as number | undefined,
    ensureChain: null as Promise<EnsureResult> | null,
    launchServerUrl: null as string | null,
    launchEpoch: 0,
    lastRecovery: undefined as
      | {
          action: "idle_retire"
          reason: "no_active_pages"
          at: number
          beforeBytes?: number
          afterBytes: number
          reclaimedBytes?: number
        }
      | undefined,
  }))

  export function key(): string {
    return "browser-host-broker"
  }

  export function enabled(): boolean {
    const configured = RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_AUTOSTART?.trim().toLowerCase()
    return configured !== "0" && configured !== "false"
  }

  export function status(): BrowserHostStatus {
    const instanceState = runtimeState()

    if (BrowserBroker.ready("webrtc")) return "ready"
    if (!enabled()) return "unavailable"
    return instanceState.hostStatus
  }

  export function resourceStats() {
    const instanceState = runtimeState()

    const active = instanceState.proc?.exitCode === null ? instanceState.proc : undefined
    if (active) {
      const sample = ProcessInspection.rssBytes(active.pid)
      if (sample !== undefined) {
        instanceState.currentRssBytes = sample
        instanceState.baselineRssBytes =
          instanceState.baselineRssBytes === undefined ? sample : Math.min(instanceState.baselineRssBytes, sample)
        instanceState.peakRssBytes = Math.max(instanceState.peakRssBytes, sample)
      }
    } else {
      instanceState.currentRssBytes = undefined
    }
    return {
      processCount: active ? 1 : 0,
      measuredProcessCount: active && instanceState.currentRssBytes !== undefined ? 1 : 0,
      currentBytes: instanceState.currentRssBytes,
      baselineBytes: instanceState.baselineRssBytes,
      peakBytes: instanceState.peakRssBytes || undefined,
      retainedBytes:
        instanceState.currentRssBytes === undefined
          ? undefined
          : Math.max(
              0,
              instanceState.currentRssBytes - (instanceState.baselineRssBytes ?? instanceState.currentRssBytes),
            ),
      lastRecovery: instanceState.lastRecovery,
    }
  }

  export function configureServerUrl(url: string): void {
    const instanceState = runtimeState()

    instanceState.listenUrl = url
  }

  export function activeServerUrl(): string | null {
    const instanceState = runtimeState()

    return instanceState.serverUrl
  }

  export async function ensure(input: EnsureInput): Promise<EnsureResult> {
    const instanceState = runtimeState()

    installActivityListener()
    cancelIdleStop()
    BrowserBroker.prepare(input.owner, input.routeDirectory, "webrtc")
    if (BrowserBroker.ready("webrtc")) {
      instanceState.hostStatus = "ready"
      return { status: "running", key: key() }
    }
    if (!enabled()) {
      instanceState.hostStatus = "unavailable"
      BrowserBroker.publishHostStatus(instanceState.hostStatus)
      return { status: "disabled", key: key() }
    }

    const resolvedServerUrl = resolveServerUrl(input.serverUrl)
    if (instanceState.ensureChain) {
      if (instanceState.launchServerUrl === resolvedServerUrl) {
        instanceState.hostStatus = "starting"
        BrowserBroker.publishHostStatus(instanceState.hostStatus)
        return { status: "running", key: key() }
      }
      // The URL differs from the in-flight launch/restart. Wait for it to
      // settle, then re-evaluate so the process is restarted with the new URL.
      const previous = instanceState.ensureChain
      const run = previous.then(
        () => ensureSettled(input, resolvedServerUrl),
        () => ensureSettled(input, resolvedServerUrl),
      )
      const tail = run.finally(() => {
        const instanceState = runtimeState()

        if (instanceState.ensureChain === tail) instanceState.ensureChain = null
      })
      instanceState.ensureChain = tail
      void tail.catch(() => undefined)
      return tail
    }

    if (instanceState.proc?.exitCode === null && instanceState.launchServerUrl === resolvedServerUrl) {
      instanceState.hostStatus = "starting"
      BrowserBroker.publishHostStatus(instanceState.hostStatus)
      return { status: "running", key: key() }
    }
    if (instanceState.proc?.exitCode === null) {
      log.info("browser.host.broker.restarting", { previous: instanceState.launchServerUrl, next: resolvedServerUrl })
      instanceState.serverUrl = resolvedServerUrl
      instanceState.launchServerUrl = resolvedServerUrl
      const pipeLogs = RuntimeContext.current().host.env.NODE_ENV !== "production"
      // A live process implies the executable is already installed, so the
      // restart is bounded (stop + spawn) and can be awaited by the caller.
      const restart = (async () => {
        await stop("restart")
        return launch(resolvedServerUrl, pipeLogs)
      })()
      const tail = restart.finally(() => {
        const instanceState = runtimeState()

        if (instanceState.ensureChain === tail) instanceState.ensureChain = null
      })
      instanceState.ensureChain = tail
      void tail.catch(() => undefined)
      return tail
    }

    instanceState.serverUrl = resolvedServerUrl
    return startLaunch(resolvedServerUrl)
  }

  function startLaunch(resolvedServerUrl: string): EnsureResult {
    const instanceState = runtimeState()

    const pipeLogs = RuntimeContext.current().host.env.NODE_ENV !== "production"
    instanceState.hostStatus =
      Installation.VERSION === "local" || RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_COMMAND
        ? "starting"
        : "installing"
    BrowserBroker.publishHostStatus(instanceState.hostStatus)
    instanceState.launchServerUrl = resolvedServerUrl
    // Resolve the command (including any managed installation) and spawn in the
    // background so the HTTP control request is never blocked by a multi-minute
    // download. Callers get a bounded wait (browser_host_pending) and retry.
    instanceState.ensureChain = launch(resolvedServerUrl, pipeLogs).finally(() => {
      const instanceState = runtimeState()

      instanceState.ensureChain = null
    })
    void instanceState.ensureChain.catch(() => undefined)
    return { status: "started", key: key() }
  }

  async function ensureSettled(input: EnsureInput, resolvedServerUrl: string): Promise<EnsureResult> {
    const instanceState = runtimeState()

    if (instanceState.proc?.exitCode === null) {
      if (instanceState.launchServerUrl === resolvedServerUrl) {
        instanceState.hostStatus = "starting"
        BrowserBroker.publishHostStatus(instanceState.hostStatus)
        return { status: "running", key: key() }
      }
      log.info("browser.host.broker.restarting", { previous: instanceState.launchServerUrl, next: resolvedServerUrl })
      instanceState.serverUrl = resolvedServerUrl
      instanceState.launchServerUrl = resolvedServerUrl
      const pipeLogs = RuntimeContext.current().host.env.NODE_ENV !== "production"
      await stop("restart")
      return launch(resolvedServerUrl, pipeLogs)
    }
    instanceState.serverUrl = resolvedServerUrl
    return startLaunch(resolvedServerUrl)
  }

  async function launch(resolvedServerUrl: string, pipeLogs: boolean): Promise<EnsureResult> {
    const instanceState = runtimeState()

    const epoch = ++instanceState.launchEpoch
    const hostCommand = await resolveCommand().catch((error) => {
      const instanceState = runtimeState()

      if (instanceState.launchEpoch !== epoch) return null
      instanceState.hostStatus = "failed"
      BrowserBroker.publishHostStatus(instanceState.hostStatus)
      log.error("browser.host.install.failed", { error })
      throw error
    })
    if (hostCommand === null || instanceState.launchEpoch !== epoch) return { status: "running", key: key() }

    // Re-assert the URL: the previous process's exit handler clears serverUrl
    // when it observes the old process exiting during a restart.
    instanceState.serverUrl = resolvedServerUrl
    instanceState.hostStatus = "starting"
    BrowserBroker.publishHostStatus(instanceState.hostStatus)
    const active = Bun.spawn(hostCommand, {
      cwd: repoRoot(),
      detached: process.platform !== "win32",
      stdout: pipeLogs ? "pipe" : "ignore",
      stderr: pipeLogs ? "pipe" : "ignore",
      env: {
        ...RuntimeContext.current().host.env,
        SYNERGY_BROWSER_HOST_SERVER_URL: resolvedServerUrl,
        SYNERGY_BROWSER_HOST_REGISTRATION_SECRET: BrowserBroker.secret(),
      },
    })
    instanceState.proc = active
    log.info("browser.host.broker.started", { pid: active.pid, serverUrl: resolvedServerUrl })
    if (pipeLogs) {
      pipe(active.stdout, "stdout")
      pipe(active.stderr, "stderr")
    }
    active.exited.finally(() => {
      const instanceState = runtimeState()

      if (instanceState.proc !== active) return
      log.info("browser.host.broker.exited", { pid: active.pid, exitCode: active.exitCode })
      instanceState.proc = null
      instanceState.serverUrl = null
      instanceState.hostStatus = active.exitCode === 0 ? "idle" : "failed"
      BrowserBroker.publishHostStatus(instanceState.hostStatus)
    })
    return { status: "started", key: key() }
  }

  export async function stop(reason: "shutdown" | "idle_no_pages" | "restart" = "shutdown"): Promise<void> {
    const instanceState = runtimeState()

    cancelIdleStop()
    instanceState.launchEpoch++
    const active = instanceState.proc
    if (!active) return
    const beforeBytes = ProcessInspection.rssBytes(active.pid) ?? instanceState.currentRssBytes
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
    if (instanceState.proc === active) instanceState.proc = null
    if (reason !== "restart") instanceState.serverUrl = null
    instanceState.hostStatus = reason === "restart" ? "restarting" : "idle"
    BrowserBroker.publishHostStatus(instanceState.hostStatus)
    instanceState.currentRssBytes = undefined
    if (reason === "idle_no_pages") {
      instanceState.lastRecovery = {
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
    const instanceState = runtimeState()

    cancelIdleStop()
    if (instanceState.proc) killHostTree(instanceState.proc, "SIGKILL")
    instanceState.proc = null
    instanceState.serverUrl = null
    instanceState.listenUrl = null
    instanceState.hostStatus = "idle"
    instanceState.baselineRssBytes = undefined
    instanceState.peakRssBytes = 0
    instanceState.currentRssBytes = undefined
    instanceState.lastRecovery = undefined
    instanceState.ensureChain = null
    instanceState.launchServerUrl = null
    instanceState.launchEpoch++
    instanceState.activityUnsubscribe?.()
    instanceState.activityUnsubscribe = null
    instanceState.activityInstalled = false
  }

  function resolveServerUrl(requestOrigin: string): string {
    const instanceState = runtimeState()

    const configured = RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_SERVER_URL?.trim()
    if (configured) {
      try {
        const parsed = new URL(configured)
        if (parsed.protocol === "http:" || parsed.protocol === "https:") return parsed.origin
      } catch {}
      log.warn("browser.host.broker.invalid_server_url_override", { value: configured })
    }
    if (!instanceState.listenUrl) return requestOrigin
    try {
      const url = new URL(instanceState.listenUrl)
      if (url.hostname === "0.0.0.0") url.hostname = "127.0.0.1"
      else if (url.hostname === "[::]") url.hostname = "[::1]"
      return url.origin
    } catch {
      return requestOrigin
    }
  }

  function installActivityListener(): void {
    const instanceState = runtimeState()

    if (instanceState.activityInstalled) return
    instanceState.activityInstalled = true
    instanceState.activityUnsubscribe = BrowserBroker.onActivity((hasPages) => {
      const instanceState = runtimeState()

      if (hasPages) {
        cancelIdleStop()
        return
      }
      if (!instanceState.proc || instanceState.idleTimer) return
      instanceState.idleTimer = setTimeout(() => {
        const instanceState = runtimeState()

        instanceState.idleTimer = null
        void stop("idle_no_pages")
      }, 60_000)
    })
  }

  function cancelIdleStop(): void {
    const instanceState = runtimeState()

    if (!instanceState.idleTimer) return
    clearTimeout(instanceState.idleTimer)
    instanceState.idleTimer = null
  }

  export async function resolveCommand(): Promise<string[]> {
    const configured = RuntimeContext.current().host.env.SYNERGY_BROWSER_HOST_COMMAND
    if (configured)
      return configured.trim().startsWith("[") ? JSON.parse(configured) : configured.split(/\s+/).filter(Boolean)
    if (Installation.VERSION === "local") {
      const source = await sourceCommand()
      if (source) return source
    }
    return [await BrowserInstall.ensureHost()]
  }

  function repoRoot(): string {
    return path.resolve(import.meta.dir, "../../..")
  }

  export async function sourceCommand(directory = import.meta.dir): Promise<string[] | undefined> {
    const desktop = path.resolve(directory, "../../../apps/desktop")
    if (!(await Bun.file(path.join(desktop, "package.json")).exists())) return
    return [BunProc.which(), "run", "--cwd", desktop, "browser-host:dev"]
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
