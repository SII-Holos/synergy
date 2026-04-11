import { DaemonHealth } from "./health"
import { DaemonState } from "./state"
import { DaemonService } from "./service"
import { DaemonSpec } from "./spec"

export namespace Daemon {
  interface DetailInput {
    installed: boolean
    runtime: Status["runtime"]
    detail?: string
  }

  export type ResolvedConfig = DaemonSpec.Network

  export type Spec = DaemonSpec.ManagedService

  export interface Status {
    installed: boolean
    manager: DaemonService.Manager
    runtime: "running" | "stopped" | "failed" | "unknown"
    specSource: "desired" | "installed"
    drifted: boolean
    url: string
    desiredUrl: string
    reachable: boolean
    portListening: boolean
    logFile: string
    desiredLogFile: string
    detail?: string
  }

  export interface ObservedState {
    manager: DaemonService.Manager
    desiredSpec: Spec
    installedSpec?: Spec
    observedSpec: Spec
    specSource: "desired" | "installed"
    drifted: boolean
    installed: boolean
    service: DaemonService.RuntimeStatus
    runtime: Status["runtime"]
    reachable: boolean
    portListening: boolean
    logFile: string
    url: string
    detail?: string
  }

  export async function resolveConfig(): Promise<ResolvedConfig> {
    return DaemonSpec.resolveNetwork()
  }

  export async function buildSpec(): Promise<Spec> {
    return DaemonSpec.resolve()
  }

  export async function install() {
    const service = await DaemonService.resolve()
    const spec = await buildSpec()
    await installCurrentSpec(service, spec)
    return { service, spec }
  }

  export async function uninstall() {
    const service = await DaemonService.resolve()
    const desiredSpec = await buildSpec()
    const manifest = await DaemonState.readManifest().catch(() => undefined)
    const spec = manifest ? specFromManifest(manifest) : desiredSpec
    await service.uninstall(spec)
    await DaemonState.removeManifest()
  }

  export async function start() {
    const service = await DaemonService.resolve()
    const spec = await buildSpec()
    await ensureCurrentInstallation(service, spec)
    await service.start(spec)
    await writeCurrentManifest(service, spec, { lastStartedAt: Date.now() })
    return { service, spec }
  }

  export async function stop() {
    const service = await DaemonService.resolve()
    const state = await observe(service)
    await service.stop(state.observedSpec)
    return { service, spec: state.observedSpec, state }
  }

  export async function waitForRunning(timeoutMs = 20_000, intervalMs = 250) {
    return waitForState((state) => state.runtime === "running", timeoutMs, intervalMs)
  }

  export async function waitForStopped(timeoutMs = 10_000, intervalMs = 250) {
    return waitForState((state) => !state.service.running, timeoutMs, intervalMs)
  }

  export async function restart() {
    const service = await DaemonService.resolve()
    const spec = await buildSpec()
    await ensureCurrentInstallation(service, spec)
    await service.restart(spec)
    await writeCurrentManifest(service, spec, { lastStartedAt: Date.now() })
    return { service, spec }
  }

  export async function observe(service?: DaemonService.Service): Promise<ObservedState> {
    const resolvedService = service ?? (await DaemonService.resolve())
    const desiredSpec = await buildSpec()
    const manifest = await DaemonState.readManifest().catch(() => undefined)
    const installedSpec = manifest ? specFromManifest(manifest) : undefined
    const observedSpec = installedSpec ?? desiredSpec
    const drifted = installedSpec ? manifestNeedsRefresh(manifest!, resolvedService.manager, desiredSpec) : false
    const serviceStatus = await resolvedService.status(observedSpec)
    const installed = serviceStatus.installed || Boolean(installedSpec)
    const portListening = installed
      ? await DaemonHealth.isPortListening(observedSpec.port, observedSpec.connectHostname)
      : false
    const reachable = installed ? await DaemonHealth.isReachable(observedSpec.url) : false
    const runtime = normalizeRuntimeState(serviceStatus, reachable, portListening)
    const detail = normalizeStatusDetail({
      installed,
      runtime,
      detail: serviceStatus.detail,
    })

    return {
      manager: resolvedService.manager,
      desiredSpec,
      installedSpec,
      observedSpec,
      specSource: installedSpec ? "installed" : "desired",
      drifted,
      installed,
      service: serviceStatus,
      runtime,
      reachable,
      portListening,
      logFile: observedSpec.logFile,
      url: observedSpec.url,
      detail,
    }
  }

  export async function status(): Promise<Status> {
    const state = await observe()
    return {
      installed: state.installed,
      manager: state.manager,
      runtime: state.runtime,
      specSource: state.specSource,
      drifted: state.drifted,
      url: state.url,
      desiredUrl: state.desiredSpec.url,
      reachable: state.reachable,
      portListening: state.portListening,
      logFile: state.logFile,
      desiredLogFile: state.desiredSpec.logFile,
      detail: state.detail,
    }
  }

  async function installCurrentSpec(service: DaemonService.Service, spec: Spec) {
    await DaemonState.ensureDirs()
    await service.install(spec)
    await writeCurrentManifest(service, spec)
  }

  async function ensureCurrentInstallation(service: DaemonService.Service, spec: Spec) {
    await DaemonState.ensureDirs()
    const runtime = await service.status(spec)
    const manifest = await DaemonState.readManifest().catch(() => undefined)
    const drifted = !manifest || manifestNeedsRefresh(manifest, service.manager, spec)
    if (!runtime.installed || drifted) {
      await service.install(spec)
      await writeCurrentManifest(service, spec)
    }
  }

  async function writeCurrentManifest(service: DaemonService.Service, spec: Spec, extra?: { lastStartedAt?: number }) {
    await DaemonState.writeManifest({
      label: spec.label,
      manager: service.manager,
      hostname: spec.hostname,
      port: spec.port,
      url: spec.url,
      command: spec.command,
      cwd: spec.cwd,
      logFile: spec.logFile,
      env: spec.env,
      connectHostname: spec.connectHostname,
      mdns: spec.mdns,
      cors: spec.cors,
      ...extra,
    })
  }

  function specFromManifest(manifest: DaemonState.Manifest): Spec {
    return {
      label: manifest.label,
      hostname: manifest.hostname,
      port: manifest.port,
      url: manifest.url,
      command: manifest.command,
      cwd: manifest.cwd,
      env: manifest.env ?? {},
      logFile: DaemonState.resolveLogFile(manifest),
      connectHostname: manifest.connectHostname ?? DaemonSpec.normalizeConnectHostname(manifest.hostname),
      mdns: manifest.mdns ?? false,
      cors: manifest.cors ?? [],
    }
  }

  function manifestNeedsRefresh(manifest: DaemonState.Manifest, manager: DaemonService.Manager, spec: Spec) {
    if (manifest.manager !== manager) return true
    if (manifest.label !== spec.label) return true
    if (manifest.hostname !== spec.hostname) return true
    if (manifest.port !== spec.port) return true
    if (manifest.url !== spec.url) return true
    if (manifest.cwd !== spec.cwd) return true
    if ((manifest.connectHostname ?? manifest.hostname) !== spec.connectHostname) return true
    if ((manifest.mdns ?? false) !== spec.mdns) return true
    const previousCors = manifest.cors ?? []
    if (previousCors.length !== spec.cors.length) return true
    if (previousCors.some((value: string, index: number) => value !== spec.cors[index])) return true
    if (DaemonState.resolveLogFile(manifest) !== spec.logFile) return true
    if (manifest.command.length !== spec.command.length) return true
    if (manifest.command.some((value, index) => value !== spec.command[index])) return true
    const currentEnv = spec.env
    const previousEnv = manifest.env ?? {}
    for (const key of ENV_DRIFT_KEYS) {
      if ((currentEnv[key] ?? "") !== (previousEnv[key] ?? "")) return true
    }
    return false
  }

  const ENV_DRIFT_KEYS = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "SYNERGY_DAEMON",
    "SYNERGY_BIN_PATH",
    "SYNERGY_CWD",
    "SYNERGY_CONFIG_DIR",
    "SYNERGY_CONFIG_CONTENT",
  ]

  function normalizeRuntimeState(
    serviceStatus: DaemonService.RuntimeStatus,
    reachable: boolean,
    portListening: boolean,
  ): Status["runtime"] {
    if (!serviceStatus.installed) {
      return reachable || portListening ? "unknown" : "stopped"
    }
    if (reachable) return "running"
    if (serviceStatus.running) return "failed"
    return portListening ? "unknown" : "stopped"
  }

  function normalizeStatusDetail(input: DetailInput) {
    const detail = input.detail?.trim()
    if (!detail) {
      if (!input.installed) return "Service not installed"
      if (input.runtime === "stopped") return "Service installed but stopped"
      return undefined
    }
    if (input.runtime === "stopped") {
      if (/bad request\.?/i.test(detail)) return "Service installed but stopped"
      if (/not installed/i.test(detail)) {
        return input.installed ? "Service installed but stopped" : "Service not installed"
      }
    }
    return detail
  }

  async function waitForState(
    accept: (state: ObservedState) => boolean,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<{ ok: boolean; state: ObservedState }> {
    const service = await DaemonService.resolve()
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const state = await observe(service)
      if (accept(state)) {
        return { ok: true, state }
      }
      await Bun.sleep(intervalMs)
    }

    const state = await observe(service)
    return { ok: accept(state), state }
  }
}
