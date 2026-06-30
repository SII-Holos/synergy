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

type BackendEvent = "update-available" | "update-not-available" | "download-progress" | "update-downloaded" | "error"

export interface DesktopUpdateBackend {
  checkForUpdates(): Promise<{ version: string | null }>
  downloadUpdate(): Promise<void>
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
  backend?: DesktopUpdateBackend
}

export class DesktopUpdater {
  private readonly events = new EventEmitter()
  private readonly store: DesktopUpdateStore
  private readonly backend: DesktopUpdateBackend
  private readonly stopServer: () => Promise<void>
  private initialized = false
  private checking: Promise<DesktopUpdateStatus> | null = null
  private downloading: Promise<DesktopUpdateStatus> | null = null
  private status: DesktopUpdateStatus

  constructor(options: DesktopUpdaterOptions) {
    this.store = DesktopUpdateStore.atUserData(options.userDataDir)
    this.backend = options.backend ?? new ElectronUpdateBackend()
    this.stopServer = options.stopServer
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
    this.updateStatus({ phase: "installing", error: null, percent: null })
    await this.stopServer()
    await this.backend.quitAndInstall()
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
      this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
      return this.getStatus()
    }
  }

  private bindBackendEvents(): void {
    this.backend.on("update-available", (info: { version?: string }) => {
      const version = typeof info?.version === "string" ? info.version : this.status.availableVersion
      this.updateStatus({ phase: "available", availableVersion: version, error: null })
      if (this.status.mode === "auto") void this.download()
    })
    this.backend.on("update-not-available", () => {
      this.updateStatus({ phase: this.enabled() ? "idle" : "disabled", availableVersion: null, percent: null })
    })
    this.backend.on("download-progress", (progress: { percent?: number }) => {
      const percent = typeof progress?.percent === "number" ? Math.max(0, Math.min(100, progress.percent)) : null
      this.updateStatus({ phase: "downloading", percent })
    })
    this.backend.on("update-downloaded", (info: { version?: string }) => {
      const version = typeof info?.version === "string" ? info.version : this.status.availableVersion
      this.updateStatus({ phase: "ready", availableVersion: version, percent: null, error: null })
    })
    this.backend.on("error", (error: unknown) => {
      this.updateStatus({ phase: "error", error: errorMessage(error), percent: null })
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

class ElectronUpdateBackend implements DesktopUpdateBackend {
  private autoUpdater: any
  private loading: Promise<any> | null = null

  async checkForUpdates(): Promise<{ version: string | null }> {
    const autoUpdater = await this.load()
    const result = await autoUpdater.checkForUpdates()
    return { version: result?.updateInfo.version ?? null }
  }

  async downloadUpdate(): Promise<void> {
    const autoUpdater = await this.load()
    await autoUpdater.downloadUpdate()
  }

  async quitAndInstall(): Promise<void> {
    const autoUpdater = await this.load()
    autoUpdater.quitAndInstall(false, true)
  }

  on(event: BackendEvent, listener: (...args: any[]) => void): () => void {
    void this.load().then((autoUpdater) => autoUpdater.on(event, listener))
    return () => void this.load().then((autoUpdater) => autoUpdater.off(event, listener))
  }

  private async load(): Promise<any> {
    if (this.autoUpdater) return this.autoUpdater
    this.loading ??= import("electron-updater").then((mod) => {
      mod.autoUpdater.autoDownload = false
      mod.autoUpdater.allowPrerelease = false
      return mod.autoUpdater
    })
    this.autoUpdater = await this.loading
    return this.autoUpdater
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
