import { spawn } from "node:child_process"
import { closeSync, openSync } from "node:fs"
import { SynergyLinkControlClient } from "./control/client"
import type { SynergyLinkLogsPayload, SynergyLinkServiceSnapshot } from "./control/schema"
import { Platform } from "./platform"
import { SynergyLinkStore, type SynergyLinkState } from "./state/store"
import { SynergyLinkLocalService } from "./service/local"

interface SynergyLinkLaunchContext {
  launcherPath: string
  invocationEntry?: string
  printLogs?: boolean
}

interface PersistedServiceStateUpdate {
  desiredState?: SynergyLinkState["service"]["desiredState"]
  runtimeStatus?: SynergyLinkState["service"]["runtimeStatus"]
  pid?: number
  printLogs?: boolean
  startedAt?: number
  stoppedAt?: number
  lastExitAt?: number
  logPath?: string
}

export namespace SynergyLinkService {
  export async function status(): Promise<SynergyLinkServiceSnapshot> {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({ action: "service.status" })
    }

    const { state, running } = await loadReconciledState()
    return snapshotFromState(state, running)
  }

  export async function start(input: SynergyLinkLaunchContext) {
    if (await SynergyLinkControlClient.isAvailable()) {
      return {
        changed: false,
        alreadyRunning: true,
        ...(await status()),
      }
    }

    const { state, running: currentRunning } = await loadReconciledState()
    if (currentRunning) {
      await updatePersistedServiceState({
        desiredState: "running",
        runtimeStatus: "running",
      })
      return {
        changed: false,
        alreadyRunning: true,
        ...(await status()),
      }
    }

    await SynergyLinkStore.ensureRoot()
    await SynergyLinkLocalService.removeSocketFile(SynergyLinkStore.controlSocketPath())
    const outputPath = SynergyLinkStore.logsPath()
    const stdout = openSync(outputPath, "a")
    const command = resolveServerLaunchCommand(input)

    await updatePersistedServiceState({
      desiredState: "running",
      runtimeStatus: "starting",
      printLogs: input.printLogs ?? false,
      logPath: outputPath,
    })

    try {
      const child = spawn(command.file, command.args, {
        detached: true,
        stdio: ["ignore", stdout, stdout],
        windowsHide: true,
      })
      child.unref()
      await waitForControlPlane(2_500)
      const controlPlaneReady = await SynergyLinkControlClient.isAvailable()
      await updatePersistedServiceState((currentState) => ({
        desiredState: controlPlaneReady ? "running" : "stopped",
        runtimeStatus: controlPlaneReady ? "running" : "stopped",
        pid: controlPlaneReady ? child.pid : undefined,
        startedAt: controlPlaneReady ? Date.now() : currentState.service.startedAt,
        stoppedAt: controlPlaneReady ? undefined : Date.now(),
        lastExitAt: controlPlaneReady ? currentState.service.lastExitAt : Date.now(),
        printLogs: input.printLogs ?? false,
        logPath: outputPath,
      }))
      return {
        changed: controlPlaneReady,
        alreadyRunning: false,
        ...(await status()),
      }
    } finally {
      closeSync(stdout)
    }
  }

  export async function stop() {
    if (await SynergyLinkControlClient.isAvailable()) {
      const snapshot = await status()
      await SynergyLinkControlClient.request({ action: "service.stop" }).catch(() => undefined)
      await waitForControlPlaneShutdown(2_500)
      const stoppedAt = Date.now()
      await updatePersistedServiceState({
        desiredState: "stopped",
        runtimeStatus: "stopped",
        pid: undefined,
        stoppedAt,
        lastExitAt: stoppedAt,
      })
      return {
        changed: snapshot.running,
        alreadyStopped: !snapshot.running,
        ...(await status()),
      }
    }

    const { state, running } = await loadReconciledState()
    const pid = state.service.pid

    await updatePersistedServiceState({
      desiredState: "stopped",
      runtimeStatus: running ? "stopping" : "stopped",
    })

    if (!pid || !running) {
      await updatePersistedServiceState({
        pid: undefined,
        runtimeStatus: "stopped",
        stoppedAt: Date.now(),
      })
      return {
        changed: false,
        alreadyStopped: true,
        ...(await status()),
      }
    }

    await SynergyLinkLocalService.terminatePid(pid)
    await SynergyLinkLocalService.removeSocketFile(SynergyLinkStore.controlSocketPath())
    const stoppedAt = Date.now()
    await updatePersistedServiceState({
      desiredState: "stopped",
      runtimeStatus: "stopped",
      pid: undefined,
      stoppedAt,
      lastExitAt: stoppedAt,
    })
    return {
      changed: true,
      alreadyStopped: false,
      ...(await status()),
    }
  }

  export async function restart(input: SynergyLinkLaunchContext) {
    const stopped = await stop()
    const started = await start(input)
    return { stopped, started }
  }

  export async function readLogs(input?: {
    maxBytes?: number
    tailLines?: number
    since?: string
  }): Promise<SynergyLinkLogsPayload> {
    if (await SynergyLinkControlClient.isAvailable()) {
      return await SynergyLinkControlClient.request({
        action: "logs.read",
        tailLines: input?.tailLines,
        since: input?.since,
        maxBytes: input?.maxBytes,
      })
    }
    const state = await SynergyLinkStore.loadState()
    const outputPath = state.logs.filePath || SynergyLinkStore.logsPath()
    return await SynergyLinkLocalService.readLogsFile(outputPath, input)
  }

  export async function followLogs(input: {
    tailLines?: number
    since?: string
    onChunk: (chunk: string) => void
  }): Promise<void> {
    const state = await SynergyLinkStore.loadState()
    const outputPath = state.logs.filePath || SynergyLinkStore.logsPath()
    await SynergyLinkLocalService.followLogsFile({
      outputPath,
      tailLines: input.tailLines,
      since: input.since,
      onChunk: input.onChunk,
    })
  }
}

function resolveServerLaunchCommand(input: SynergyLinkLaunchContext) {
  const serverArgs = ["server"]
  if (input.printLogs) serverArgs.push("--print-logs")

  const invocationEntry = input.invocationEntry
  if (!invocationEntry || invocationEntry === input.launcherPath) {
    return { file: input.launcherPath, args: serverArgs }
  }

  const isBunVirtualEntrypoint = invocationEntry.startsWith("/$bunfs/") || invocationEntry.endsWith("/cli.js")
  if (isBunVirtualEntrypoint) {
    return { file: input.launcherPath, args: serverArgs }
  }

  return { file: input.launcherPath, args: [invocationEntry, ...serverArgs] }
}

function snapshotFromState(state: SynergyLinkState, running: boolean): SynergyLinkServiceSnapshot {
  return {
    desiredState: state.service.desiredState,
    runtimeStatus: state.service.runtimeStatus,
    running,
    pid: state.service.pid,
    startedAt: state.service.startedAt,
    stoppedAt: state.service.stoppedAt,
    lastExitAt: state.service.lastExitAt,
    printLogs: state.service.printLogs,
    logPath: state.logs.filePath || SynergyLinkStore.logsPath(),
  }
}

async function loadReconciledState(): Promise<{ state: SynergyLinkState; running: boolean }> {
  const state = await SynergyLinkStore.loadState()
  const running = Boolean(state.service.pid && SynergyLinkLocalService.isPidRunning(state.service.pid))
  if (reconcileObservedRuntimeState(state, running)) {
    await SynergyLinkStore.saveState(state)
  }
  return { state, running }
}

async function updatePersistedServiceState(
  update: PersistedServiceStateUpdate | ((state: SynergyLinkState) => PersistedServiceStateUpdate),
): Promise<SynergyLinkState> {
  const state = await SynergyLinkStore.loadState()
  const nextUpdate = typeof update === "function" ? update(state) : update
  if (applyPersistedServiceStateUpdate(state, nextUpdate)) {
    await SynergyLinkStore.saveState(state)
  }
  return state
}

function reconcileObservedRuntimeState(state: SynergyLinkState, running: boolean): boolean {
  const expectedRuntimeStatus = running ? "running" : "stopped"
  return applyPersistedServiceStateUpdate(state, {
    runtimeStatus:
      state.service.runtimeStatus === expectedRuntimeStatus && !(state.service.pid && !running)
        ? undefined
        : expectedRuntimeStatus,
    pid: state.service.pid && !running ? undefined : state.service.pid,
  })
}

function applyPersistedServiceStateUpdate(state: SynergyLinkState, update: PersistedServiceStateUpdate): boolean {
  let changed = false

  if (update.desiredState !== undefined && state.service.desiredState !== update.desiredState) {
    state.service.desiredState = update.desiredState
    changed = true
  }
  if (update.runtimeStatus !== undefined && state.service.runtimeStatus !== update.runtimeStatus) {
    state.service.runtimeStatus = update.runtimeStatus
    changed = true
  }
  if (Object.hasOwn(update, "pid") && state.service.pid !== update.pid) {
    state.service.pid = update.pid
    changed = true
  }
  if (update.printLogs !== undefined && state.service.printLogs !== update.printLogs) {
    state.service.printLogs = update.printLogs
    changed = true
  }
  if (Object.hasOwn(update, "startedAt") && state.service.startedAt !== update.startedAt) {
    state.service.startedAt = update.startedAt
    changed = true
  }
  if (Object.hasOwn(update, "stoppedAt") && state.service.stoppedAt !== update.stoppedAt) {
    state.service.stoppedAt = update.stoppedAt
    changed = true
  }
  if (Object.hasOwn(update, "lastExitAt") && state.service.lastExitAt !== update.lastExitAt) {
    state.service.lastExitAt = update.lastExitAt
    changed = true
  }
  if (update.logPath !== undefined && state.logs.filePath !== update.logPath) {
    state.logs.filePath = update.logPath
    changed = true
  }

  return changed
}

async function waitForControlPlane(timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await SynergyLinkControlClient.isAvailable()) {
      return
    }
    await Platform.sleep(100)
  }
}

async function waitForControlPlaneShutdown(timeoutMs: number) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (!(await SynergyLinkControlClient.isAvailable())) {
      return
    }
    await Platform.sleep(100)
  }
}
