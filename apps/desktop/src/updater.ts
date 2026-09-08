import { EventEmitter } from "node:events"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import type { DesktopChannel } from "./identity.js"

export const DesktopUpdateMode = z.enum(["auto", "notify", "manual", "none"])
export type DesktopUpdateMode = z.infer<typeof DesktopUpdateMode>

export const DesktopUpdatePhase = z.enum([
  "disabled",
  "idle",
  "checking",
  "available",
  "downloading",
  "ready",
  "installing",
  "error",
])
export type DesktopUpdatePhase = z.infer<typeof DesktopUpdatePhase>

export interface DesktopUpdateStatus {
  channel: DesktopChannel
  mode: DesktopUpdateMode
  phase: DesktopUpdatePhase
  currentVersion: string
  availableVersion: string | null
  percent: number | null
  lastCheckedAt: number | null
  error: string | null
}

export type DesktopUpdateEvent = { type: "status"; status: DesktopUpdateStatus }

type BackendEvent =
  | "update-available"
  | "update-not-available"
  | "download-progress"
  | "update-downloaded"
  | "update-cancelled"
  | "error"

export interface DesktopUpdateBackend {
  checkForUpdates(): Promise<{ version: string | null }>
  downloadUpdate(): Promise<void>
  cancelDownload?(): void | Promise<void>
  quitAndInstall(): void | Promise<void>
  on(event: BackendEvent, listener: (...args: any[]) => void): () => void
}

const Preference = z
  .object({
    mode: DesktopUpdateMode.default("auto"),
  })
  .strict()
export type DesktopUpdatePreference = z.infer<typeof Preference>

export class DesktopUpdateStore {
  constructor(private filepath: string) {}

  static atUserData(userDataDir: string) {
    return new DesktopUpdateStore(path.join(userDataDir, "desktop-update.json"))
  }

  async read(): Promise<DesktopUpdatePreference> {
    const raw = await fs.readFile(this.filepath, "utf8").catch(() => "")
    if (!raw.trim()) return { mode: "auto" }
    const data = await Promise.resolve()
      .then(() => JSON.parse(raw))
      .catch(() => null)
    const parsed = Preference.safeParse(data)
    if (parsed.success) return parsed.data
    await this.write({ mode: "auto" })
    return { mode: "auto" }
  }

  async write(preference: DesktopUpdatePreference): Promise<void> {
    await fs.mkdir(path.dirname(this.filepath), { recursive: true })
    await fs.writeFile(this.filepath, JSON.stringify(Preference.parse(preference), null, 2) + "\n")
  }
}

export interface DesktopUpdaterOptions {
  channel: DesktopChannel
  currentVersion: string
  userDataDir: string
  stopServer: () => Promise<void>
  restartServer?: () => Promise<void>
  backend?: DesktopUpdateBackend
}

export class DesktopUpdater {
  private readonly events = new EventEmitter()
  private readonly store: DesktopUpdateStore
  private readonly backend: DesktopUpdateBackend
  private readonly stopServer: () => Promise<void>
  private readonly restartServer: () => Promise<void>
  private initialized = false
  private checking: Promise<DesktopUpdateStatus> | null = null
  private downloading: Promise<DesktopUpdateStatus> | null = null
  private status: DesktopUpdateStatus

  constructor(options: DesktopUpdaterOptions) {
    this.store = DesktopUpdateStore.atUserData(options.userDataDir)
    this.backend = options.backend ?? new ElectronUpdateBackend()
    this.stopServer = options.stopServer
    this.restartServer = options.restartServer ?? (() => Promise.resolve())
    this.status = {
      channel: options.channel,
      mode: "auto",
      phase: options.channel === "dev" ? "disabled" : "idle",
      currentVersion: options.currentVersion,
      availableVersion: null,
      percent: null,
      lastCheckedAt: null,
      error: null,
    }
    this.bindBackendEvents()
  }

  async init(): Promise<DesktopUpdateStatus> {
    if (this.initialized) return this.getStatus()
    this.initialized = true
    const preference = await this.store.read()
    this.updateStatus({ mode: preference.mode, phase: this.enabledFor(preference.mode) ? "idle" : "disabled" })
    if (this.status.channel === "stable" && (preference.mode === "auto" || preference.mode === "notify")) {
      void this.check({ manual: false })
    }
    return this.getStatus()
  }

  getStatus(): DesktopUpdateStatus {
    return { ...this.status }
  }

  onEvent(listener: (event: DesktopUpdateEvent) => void): () => void {
    this.events.on("event", listener)
    return () => this.events.off("event", listener)
  }

  async setMode(mode: DesktopUpdateMode): Promise<DesktopUpdateStatus> {
    if (mode === "none" && this.status.phase === "downloading") {
      await this.backend.cancelDownload?.()
    }
    await this.store.write({ mode })
    const enabled = this.enabledFor(mode)
    const phase = enabled ? (this.status.phase === "disabled" ? "idle" : this.status.phase) : "disabled"
    this.updateStatus({
      mode,
      phase,
      availableVersion: enabled ? this.status.availableVersion : null,
      error: null,
      percent: enabled ? this.status.percent : null,
    })
    if ((mode === "auto" || mode === "notify") && (phase === "idle" || phase === "error")) {
      void this.check({ manual: false })
    }
    return this.getStatus()
  }

  async check(input: { manual?: boolean } = {}): Promise<DesktopUpdateStatus> {
    if (!this.enabled()) return this.disabledStatus()
    if (!input.manual && this.status.mode === "manual") return this.getStatus()
    if (this.checking) return this.checking

    this.checking = this.checkInternal().finally(() => {
      this.checking = null
    })
    return this.checking
  }

  async download(): Promise<DesktopUpdateStatus> {
    if (!this.enabled()) return this.disabledStatus()
    if (this.downloading) return this.downloading

    this.downloading = this.downloadInternal().finally(() => {
      this.downloading = null
    })
    return this.downloading
  }

  async installAndRestart(): Promise<DesktopUpdateStatus> {
    if (!this.enabled()) return this.disabledStatus()
    if (this.status.phase !== "ready") return this.getStatus()
    this.updateStatus({ phase: "installing", error: null, percent: null })
    try {
      await this.stopServer()
      await this.backend.quitAndInstall()
    } catch (error) {
      await this.restartServer().catch(() => {})
      this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
    }
    return this.getStatus()
  }

  private async checkInternal(): Promise<DesktopUpdateStatus> {
    this.updateStatus({ phase: "checking", error: null, percent: null })
    try {
      const result = await this.backend.checkForUpdates()
      this.updateStatus({ lastCheckedAt: Date.now() })
      if (!result.version) {
        this.updateStatus({ phase: "idle", availableVersion: null, percent: null })
        return this.getStatus()
      }
      this.updateStatus({ phase: "available", availableVersion: result.version, percent: null })
      if (this.status.mode === "auto") return this.download()
      return this.getStatus()
    } catch (error) {
      this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
      return this.getStatus()
    }
  }

  private async downloadInternal(): Promise<DesktopUpdateStatus> {
    this.updateStatus({ phase: "downloading", error: null, percent: this.status.percent ?? 0 })
    try {
      await this.backend.downloadUpdate()
      if (this.status.phase === "downloading") {
        this.updateStatus({ phase: "ready", percent: null })
      }
      return this.getStatus()
    } catch (error) {
      if (!this.enabled()) return this.getStatus()
      if (error instanceof DesktopUpdateCancelledError) {
        this.updateStatus({ phase: "available", error: null, percent: null })
      } else {
        this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
      }
      return this.getStatus()
    }
  }

  private bindBackendEvents(): void {
    const whenEnabled =
      (listener: (...args: any[]) => void) =>
      (...args: any[]) => {
        if (this.enabled()) listener(...args)
      }
    this.backend.on(
      "update-available",
      whenEnabled((info: { version?: string }) => {
        const version = typeof info?.version === "string" ? info.version : this.status.availableVersion
        this.updateStatus({ phase: "available", availableVersion: version, error: null })
        if (this.status.mode === "auto") void this.download()
      }),
    )
    this.backend.on(
      "update-not-available",
      whenEnabled(() => {
        this.updateStatus({ phase: "idle", availableVersion: null, percent: null })
      }),
    )
    this.backend.on(
      "download-progress",
      whenEnabled((progress: { percent?: number }) => {
        const percent = typeof progress?.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : null
        this.updateStatus({ phase: "downloading", percent })
      }),
    )
    this.backend.on(
      "update-downloaded",
      whenEnabled((info: { version?: string }) => {
        const version = typeof info?.version === "string" ? info.version : this.status.availableVersion
        this.updateStatus({ phase: "ready", availableVersion: version, percent: null, error: null })
      }),
    )
    this.backend.on(
      "update-cancelled",
      whenEnabled(() => {
        this.updateStatus({ phase: "available", percent: null, error: null })
      }),
    )
    this.backend.on("error", (error: unknown) => {
      const wasInstalling = this.status.phase === "installing"
      this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
      if (wasInstalling) void this.restartServer().catch(() => {})
    })
  }

  private enabled(): boolean {
    return this.enabledFor(this.status.mode)
  }

  private enabledFor(mode: DesktopUpdateMode): boolean {
    return this.status.channel === "stable" && mode !== "none"
  }

  private disabledStatus(): DesktopUpdateStatus {
    this.updateStatus({ phase: "disabled", availableVersion: null, percent: null })
    return this.getStatus()
  }

  private updateStatus(patch: Partial<DesktopUpdateStatus>): void {
    this.status = { ...this.status, ...patch }
    this.events.emit("event", { type: "status", status: this.getStatus() } satisfies DesktopUpdateEvent)
  }
}

export class DesktopUpdateCancelledError extends Error {
  constructor() {
    super("Desktop update download was cancelled")
    this.name = "DesktopUpdateCancelledError"
  }
}

export function desktopUpdateInstallActive(previous: boolean, status: DesktopUpdateStatus): boolean {
  if (status.phase === "installing") return true
  if (status.phase === "error") return false
  return previous
}

type ElectronCancellationToken = { cancel(): void }

type ElectronUpdateCheckResult = {
  isUpdateAvailable: boolean
  updateInfo: { version: string }
  cancellationToken?: ElectronCancellationToken
}

type ElectronAutoUpdater = {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  checkForUpdates(): Promise<ElectronUpdateCheckResult | null>
  downloadUpdate(cancellationToken?: ElectronCancellationToken): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  on(event: BackendEvent, listener: (...args: any[]) => void): unknown
  off(event: BackendEvent, listener: (...args: any[]) => void): unknown
}

type ElectronAutoUpdaterLoader = () => Promise<ElectronAutoUpdater>

const loadElectronAutoUpdater: ElectronAutoUpdaterLoader = async () => {
  const { autoUpdater } = await import("electron-updater")
  return autoUpdater
}

export class ElectronUpdateBackend implements DesktopUpdateBackend {
  private autoUpdater: ElectronAutoUpdater | null = null
  private loading: Promise<ElectronAutoUpdater> | null = null
  private cancellationToken: ElectronCancellationToken | undefined
  private cancellationRequested = false

  constructor(private readonly loader: ElectronAutoUpdaterLoader = loadElectronAutoUpdater) {}

  async checkForUpdates(): Promise<{ version: string | null }> {
    const autoUpdater = await this.load()
    const result = await autoUpdater.checkForUpdates()
    this.cancellationToken = result?.cancellationToken
    return { version: result?.isUpdateAvailable ? result.updateInfo.version : null }
  }

  async downloadUpdate(): Promise<void> {
    const autoUpdater = await this.load()
    this.cancellationRequested = false
    try {
      await autoUpdater.downloadUpdate(this.cancellationToken)
    } catch (error) {
      if (this.cancellationRequested) throw new DesktopUpdateCancelledError()
      throw error
    }
  }

  cancelDownload(): void {
    this.cancellationRequested = true
    this.cancellationToken?.cancel()
  }

  async quitAndInstall(): Promise<void> {
    const autoUpdater = await this.load()
    autoUpdater.quitAndInstall(false, true)
  }

  on(event: BackendEvent, listener: (...args: any[]) => void): () => void {
    void this.load().then((autoUpdater) => autoUpdater.on(event, listener))
    return () => void this.load().then((autoUpdater) => autoUpdater.off(event, listener))
  }

  private async load(): Promise<ElectronAutoUpdater> {
    if (this.autoUpdater) return this.autoUpdater
    this.loading ??= this.loader().then((autoUpdater) => {
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowPrerelease = false
      return autoUpdater
    })
    this.autoUpdater = await this.loading
    return this.autoUpdater
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
