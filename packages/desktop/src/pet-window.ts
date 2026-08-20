import { BrowserWindow, screen, type BrowserWindowConstructorOptions } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { petPage } from "./pet-page.js"
import { loadPetSpriteSheet } from "./pet-sprite.js"
import { loadPetSettings, savePetSettings, toPetSettings, type PetSettingsStateV1 } from "./pet-settings.js"
import { PetStateMachine, type PetBusEvent, type PetMood } from "./pet-state.js"
import { PetSseClient, type PetSseStatus } from "./pet-sse.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))

export interface PetWindowManagerOptions {
  serverUrl: string
  userDataPath: string
  preloadPath: string
  platform: NodeJS.Platform
  runtimeLog?: (event: string, payload?: Record<string, unknown>) => void
}

export interface PetBridgeState {
  mood: PetMood
  activeSessions: string[]
  connected: boolean
}

export interface PetWindowManager {
  start(): Promise<void>
  stop(): Promise<void>
  setServerUrl(url: string | null): void
  isActive(): boolean
  getSettings(): PetSettingsStateV1
  setSettings(input: unknown): Promise<PetSettingsStateV1>
  handleIpc(channel: string, event: { sender: unknown }, payload: unknown): Promise<unknown>
}

const PET_TICK_MS = 500

function primaryWorkArea(): { x: number; y: number; width: number; height: number } {
  return screen.getAllDisplays()[0]?.workArea ?? { x: 0, y: 0, width: 1920, height: 1080 }
}

export class DesktopPetWindow implements PetWindowManager {
  private window: BrowserWindow | null = null
  private readonly state: PetStateMachine
  private sse: PetSseClient | null = null
  private sseConnected = false
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private settings: PetSettingsStateV1
  private serverUrl: string | null
  private started = false
  private readonly preloadPath: string
  private readonly platform: NodeJS.Platform
  private readonly runtimeLog: (event: string, payload?: Record<string, unknown>) => void

  constructor(private readonly options: PetWindowManagerOptions) {
    this.preloadPath = options.preloadPath
    this.platform = options.platform
    this.runtimeLog = options.runtimeLog ?? (() => undefined)
    this.settings = {
      version: 1,
      enabled: true,
      spritePath: "",
      width: 160,
      height: 140,
      position: null,
      idleTimeoutMs: 5 * 60_000,
      frameMs: 120,
    }
    this.state = new PetStateMachine({
      idleTimeoutMs: this.settings.idleTimeoutMs,
      transientMs: 4_000,
    })
    this.serverUrl = options.serverUrl
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    this.settings = await loadPetSettings(this.options.userDataPath)
    this.state.idleTimeoutMs = this.settings.idleTimeoutMs
    if (!this.settings.enabled) {
      this.runtimeLog("petDisabled")
      return
    }
    this.createWindow()
    this.connectSse()
    this.tickTimer = setInterval(() => {
      this.state.tick()
      this.broadcastState()
    }, PET_TICK_MS)
  }

  async stop(): Promise<void> {
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
    this.sse?.close()
    this.sse = null
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    this.window = null
    this.started = false
  }

  setServerUrl(url: string | null): void {
    this.serverUrl = url
    if (!this.started) return
    this.sse?.close()
    this.sse = null
    if (url) this.connectSse()
  }

  isActive(): boolean {
    return this.started && this.window !== null && !this.window.isDestroyed()
  }

  getSettings(): PetSettingsStateV1 {
    return { ...this.settings }
  }

  async setSettings(input: unknown): Promise<PetSettingsStateV1> {
    const next = { ...this.settings }
    const update = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>
    if (typeof update.enabled === "boolean") next.enabled = update.enabled
    if (typeof update.spritePath === "string") next.spritePath = update.spritePath
    if (typeof update.width === "number") next.width = update.width
    if (typeof update.height === "number") next.height = update.height
    if (update.position && typeof update.position === "object") {
      const pos = update.position as { x?: unknown; y?: unknown }
      if (typeof pos.x === "number" && typeof pos.y === "number") next.position = { x: pos.x, y: pos.y }
    }
    if (typeof update.idleTimeoutMs === "number") next.idleTimeoutMs = update.idleTimeoutMs
    if (typeof update.frameMs === "number") next.frameMs = update.frameMs
    this.settings = next
    this.state.idleTimeoutMs = next.idleTimeoutMs
    await savePetSettings(this.options.userDataPath, next)
    this.applySettingsToWindow()
    this.broadcastSettings()
    return { ...next }
  }

  private createWindow(): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.destroy()
    }
    const workArea = primaryWorkArea()
    const width = Math.min(this.settings.width, workArea.width)
    const height = Math.min(this.settings.height, workArea.height)
    const position = this.settings.position ?? {
      x: workArea.x + workArea.width - width - 24,
      y: workArea.y + workArea.height - height - 24,
    }
    const windowOptions: BrowserWindowConstructorOptions = {
      show: false,
      width,
      height,
      x: position.x,
      y: position.y,
      frame: false,
      transparent: true,
      resizable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hasShadow: false,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      webPreferences: {
        preload: this.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    }
    this.window = new BrowserWindow(windowOptions)
    this.window.setAlwaysOnTop(true, "floating")
    this.window.setSkipTaskbar(true)
    this.window.setResizable(false)
    this.window.setPosition(position.x, position.y)
    this.window.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    this.window.webContents.on("will-navigate", (event, url) => {
      event.preventDefault()
    })
    void this.loadPage()
    this.window.on("closed", () => {
      if (this.window) this.window = null
    })
    this.window.show()
  }

  private async loadPage(): Promise<void> {
    if (!this.window || this.window.isDestroyed()) return
    const sprite = await loadPetSpriteSheet(this.settings.spritePath, this.settings.frameMs)
    if (!this.window || this.window.isDestroyed()) return
    const url = petPage({ settings: toPetSettings(this.settings), sprite })
    await this.window.webContents.loadURL(url)
  }

  private connectSse(): void {
    if (!this.serverUrl) return
    const base = this.serverUrl.replace(/\/+$/, "")
    const url = `${base}/global/event?stream=delta`
    this.sse = new PetSseClient({
      url,
      onEvent: (event: PetBusEvent) => {
        this.state.handleEvent(event)
        this.broadcastState()
      },
      onStatus: (status: PetSseStatus) => {
        this.sseConnected = status === "connected"
        this.broadcastState()
      },
      reconnectBaseMs: 1_000,
      reconnectMaxMs: 15_000,
    })
    this.sse.start()
  }

  private broadcastState(): void {
    if (!this.window || this.window.isDestroyed()) return
    const snapshot = this.state.snapshot()
    this.window.webContents.send("pet:state", {
      mood: snapshot.mood,
      activeSessions: snapshot.activeSessions,
      connected: this.sseConnected,
    })
  }

  private broadcastSettings(): void {
    if (!this.window || this.window.isDestroyed()) return
    this.window.webContents.send("pet:settings", toPetSettings(this.settings))
  }

  private broadcastSprite(): void {
    if (!this.window || this.window.isDestroyed()) return
    void loadPetSpriteSheet(this.settings.spritePath, this.settings.frameMs).then((sprite) => {
      if (this.window && !this.window.isDestroyed()) {
        this.window.webContents.send("pet:sprite", sprite)
      }
    })
  }

  private applySettingsToWindow(): void {
    if (!this.window || this.window.isDestroyed()) return
    const workArea = primaryWorkArea()
    const width = Math.min(this.settings.width, workArea.width)
    const height = Math.min(this.settings.height, workArea.height)
    const current = this.window.getPosition()
    const position = this.settings.position ?? { x: current[0], y: current[1] }
    this.window.setBounds({ x: position.x, y: position.y, width, height })
    this.broadcastSprite()
  }

  async handleIpc(channel: string, event: { sender: unknown }, payload: unknown): Promise<unknown> {
    if (!this.window || event.sender !== this.window.webContents) {
      return { ok: false, error: "pet_sender_rejected" }
    }
    switch (channel) {
      case "pet.poke":
        this.state.poke()
        this.broadcastState()
        return { ok: true }
      case "pet.dragBy": {
        const delta = payload as { dx?: unknown; dy?: unknown }
        const dx = typeof delta?.dx === "number" ? delta.dx : 0
        const dy = typeof delta?.dy === "number" ? delta.dy : 0
        const currentPosition = this.window.getPosition()
        const x = currentPosition[0] ?? 0
        const y = currentPosition[1] ?? 0
        const nextX = Math.round(x + dx)
        const nextY = Math.round(y + dy)
        this.window.setPosition(nextX, nextY)
        this.settings.position = { x: nextX, y: nextY }
        await savePetSettings(this.options.userDataPath, this.settings)
        return { ok: true }
      }
      case "pet.setDragging": {
        const dragging = payload as { dragging?: unknown }
        this.state.setDragging(dragging?.dragging === true)
        this.broadcastState()
        return { ok: true }
      }
      case "pet.getState": {
        const snapshot = this.state.snapshot()
        return {
          ok: true,
          state: {
            mood: snapshot.mood,
            activeSessions: snapshot.activeSessions,
            connected: this.sseConnected,
          },
        }
      }
      default:
        return { ok: false, error: "pet_unknown_channel" }
    }
  }
}

export function petPreloadPath(): string {
  return path.join(dirname, "pet-preload.cjs")
}
