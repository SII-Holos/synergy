import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type BrowserWindowConstructorOptions,
} from "electron"
import { readFile } from "node:fs/promises"
import { randomBytes } from "node:crypto"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { BrowserNativeViewManager } from "./browser-native-view.js"
import { BrowserHostBrokerClient } from "./browser-host-broker.js"
import { BrowserNativePagePool } from "./browser-native-page-pool.js"
import { BrowserNativeLease } from "@ericsanchezok/synergy-browser/native-lease"
import { BrowserRegistrationSecretSchema } from "@ericsanchezok/synergy-browser"
import { desktopErrorPage } from "./error-page.js"
import {
  DESKTOP_PROTOCOL,
  type DesktopChannel,
  desktopAppUserModelId,
  desktopChannel,
  desktopServerMode,
  desktopWindowTitle,
  isDebugEnabled,
} from "./identity.js"
import {
  parseBrowserNativeAttach,
  parseBrowserNativePage,
  parseBrowserNativeResize,
  parseBrowserNativePresentationTicket,
  parseClipboardWriteText,
  parseExternalUrl,
} from "./ipc-contract.js"
import { selectDirectoryWithNativeDialog } from "./directory-picker.js"
import { installAppMenu } from "./menu.js"
import { DesktopServerManager } from "./server-manager.js"
import { enforceProductionLoading, installSessionSecurity, installWindowSecurity } from "./security.js"
import { DesktopStartupOverlay } from "./startup-overlay.js"
import type { DesktopStartupStatus } from "./startup-page.js"
import { DesktopUpdateMode, DesktopUpdater } from "./updater.js"
import {
  applyDesktopThemeToWindow,
  desktopThemeBackground,
  desktopThemeSnapshot,
  loadDesktopThemeSource,
  parseDesktopThemeSource,
  saveDesktopThemeSource,
  type DesktopThemeSnapshot,
} from "./theme.js"
import { loadWindowState, scheduleWindowStatePersistence } from "./window-state.js"
import {
  desktopDevDockIconPath,
  desktopIconPath,
  desktopShouldHideToTray,
  desktopStartupIconPath,
  desktopUsesSystemTray,
  desktopWindowChromeOptions,
  desktopWindowState,
} from "./window-chrome.js"
import { applyDesktopUnreadUpdate, desktopUnreadAssetPaths, desktopUnreadPresentation } from "./unread-indicator.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))
process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET ??= randomBytes(32).toString("hex")
BrowserRegistrationSecretSchema.parse(process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET)

let mainWindow: BrowserWindow | null = null
let startupOverlay: DesktopStartupOverlay | null = null
let nativeViews: BrowserNativeViewManager | null = null
let nativePagePool: BrowserNativePagePool | null = null
let browserBroker: BrowserHostBrokerClient | null = null
let browserBrokerOrigin: string | null = null
let serverManager: DesktopServerManager | null = null
let updater: DesktopUpdater | null = null
let desktopTray: Tray | null = null
let currentAppURL: string | null = null
let shouldStart = true
let isQuitting = false
let isUpdateQuit = false
let pendingCreateWindow: Promise<void> | null = null
let currentDesktopTheme: DesktopThemeSnapshot | null = null
let unreadCompletionCount = 0
let desktopUnreadOverlayIcon: ReturnType<typeof nativeImage.createFromPath> | null = null
let desktopUnreadTrayIcon: ReturnType<typeof nativeImage.createFromPath> | null = null
let desktopTrayDefaultIcon: ReturnType<typeof nativeImage.createFromPath> | null = null

const updateQuitApp = app as typeof app & {
  on(event: "before-quit-for-update", listener: () => void): typeof app
}

try {
  app.setAppUserModelId(desktopAppUserModelId(desktopChannel(app.isPackaged)))
} catch {
  // AppUserModelId is only meaningful on Windows.
}

if (!app.requestSingleInstanceLock()) {
  shouldStart = false
  app.quit()
}

function runtimeLog(message: string, data?: Record<string, unknown>) {
  if (process.env.SYNERGY_DESKTOP_RUNTIME_TEST !== "1") return
  console.log(`[desktop-runtime] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`)
}

async function loadStartupIconDataURL(iconPath: string): Promise<string | undefined> {
  try {
    const data = await readFile(iconPath)
    return `data:image/png;base64,${data.toString("base64")}`
  } catch (error) {
    runtimeLog("startupIconUnavailable", {
      iconPath,
      error: error instanceof Error ? error.message : String(error),
    })
    return undefined
  }
}

runtimeLog("mainLoaded", { argv: process.argv })

function loadDesktopUnreadImage(assetPath: string | undefined, asset: string) {
  if (!assetPath) return null
  const image = nativeImage.createFromPath(assetPath)
  if (!image.isEmpty()) return image
  runtimeLog("unreadIndicatorAssetUnavailable", { asset, assetPath })
  return null
}

function initializeDesktopUnreadAssets(): void {
  const paths = desktopUnreadAssetPaths({
    platform: process.platform,
    dirname,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  desktopUnreadOverlayIcon = loadDesktopUnreadImage(paths.overlay, "overlay")
  desktopUnreadTrayIcon = loadDesktopUnreadImage(paths.trayUnread, "tray")
}

function applyDesktopUnreadState(): void {
  const presentation = desktopUnreadPresentation(
    process.platform,
    unreadCompletionCount,
    desktopWindowTitle(desktopChannel(app.isPackaged)),
  )
  if (presentation.dockBadge !== undefined) app.dock?.setBadge(presentation.dockBadge)
  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    const overlay = presentation.overlayVisible ? desktopUnreadOverlayIcon : null
    mainWindow.setOverlayIcon(overlay, presentation.overlayDescription)
  }
  if (presentation.launcherBadgeCount !== undefined) {
    app.setBadgeCount(presentation.launcherBadgeCount)
  }
  if (desktopTray) {
    const image = presentation.trayUnread ? desktopUnreadTrayIcon : desktopTrayDefaultIcon
    if (image) desktopTray.setImage(image)
    desktopTray.setToolTip(presentation.trayTooltip)
  }
}

function setDesktopUnreadCount(count: number): void {
  unreadCompletionCount = count
  applyDesktopUnreadState()
}

async function createWindow() {
  const channel = desktopChannel(app.isPackaged)
  const mode = desktopServerMode(channel)
  serverManager ??= new DesktopServerManager({
    channel,
    mode,
    resourcesPath: process.resourcesPath,
    logDir: desktopLogDir(),
    externalUrl: process.env.SYNERGY_DESKTOP_APP_URL,
  })
  if (!updater) {
    updater = new DesktopUpdater({
      channel,
      currentVersion: app.getVersion(),
      userDataDir: app.getPath("userData"),
      stopServer: () => serverManager?.stop() ?? Promise.resolve(),
    })
    updater.onEvent((event) => mainWindow?.webContents.send("desktop-update:event", event))
    await updater.init()
  }

  const windowState = await loadWindowState(app.getPath("userData"))
  const startupIconDataUrl = await loadStartupIconDataURL(
    desktopStartupIconPath({
      platform: process.platform,
      dirname,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
  )
  const preloadPath = path.join(dirname, "preload.cjs")
  const theme = getDesktopThemeSnapshot()
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    width: windowState.width,
    height: windowState.height,
    title: desktopWindowTitle(channel),
    backgroundColor: desktopThemeBackground(theme.effective),
    ...desktopWindowChromeOptions({
      platform: process.platform,
      dirname,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  }
  if (windowState.x !== undefined && windowState.y !== undefined) {
    windowOptions.x = windowState.x
    windowOptions.y = windowState.y
  }

  mainWindow = new BrowserWindow(windowOptions)
  applyDesktopUnreadState()
  runtimeLog("createWindow", { mode, show: process.env.SYNERGY_DESKTOP_SHOW !== "0" })
  if (process.platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false)
  }
  nativePagePool ??= new BrowserNativePagePool()
  nativeViews = new BrowserNativeViewManager(mainWindow, nativePagePool)
  installWindowSecurity(mainWindow, () => currentAppURL)
  enforceProductionLoading(mainWindow.webContents, () => currentAppURL)
  scheduleWindowStatePersistence(mainWindow, app.getPath("userData"))
  installWindowInputShortcuts(mainWindow, isDebugEnabled(channel))
  installDesktopWindowStateEvents(mainWindow)
  installWindowCloseBehavior(mainWindow)

  if (windowState.maximized) mainWindow.maximize()
  startupOverlay = new DesktopStartupOverlay({
    window: mainWindow,
    preloadPath,
    chrome: process.platform === "darwin" ? "native" : "custom",
    iconDataUrl: startupIconDataUrl,
    theme: theme.effective,
  })
  await startupOverlay.load()
  startupOverlay.attach()
  if (process.env.SYNERGY_DESKTOP_SHOW !== "0") {
    mainWindow.show()
  }

  mainWindow.on("closed", () => {
    startupOverlay?.destroy()
    startupOverlay = null
    nativeViews?.destroy()
    nativeViews = null
    mainWindow = null
  })

  await setStartupStatus({
    title: mode === "external" ? "Connecting to Synergy" : "Starting local runtime",
    detail:
      mode === "external"
        ? "Opening the configured desktop app surface."
        : "Synergy is opening the local server and workspace.",
  })

  const targetURL = await resolveAppURL()
  startLocalBrowserBroker()
  await setStartupStatus({
    title: currentAppURL ? "Loading workspace" : "Startup needs attention",
    detail: currentAppURL
      ? "Connecting to the local app surface."
      : "Synergy could not start the local runtime. Opening diagnostics.",
  })
  try {
    await mainWindow.loadURL(targetURL)
  } catch (error) {
    await dismissStartupOverlay()
    throw error
  }
  await dismissStartupOverlay()
  runtimeLog("windowLoaded", { url: mainWindow.webContents.getURL() })
}

async function initializeDesktopTheme(): Promise<void> {
  const source = await loadDesktopThemeSource(app.getPath("userData"))
  updateDesktopThemeSnapshot(snapshotDesktopTheme(source), { broadcast: false })
}

function getDesktopThemeSnapshot(): DesktopThemeSnapshot {
  currentDesktopTheme ??= snapshotDesktopTheme("system")
  return currentDesktopTheme
}

function updateDesktopThemeSnapshot(
  snapshot: DesktopThemeSnapshot,
  options: { broadcast?: boolean } = {},
): DesktopThemeSnapshot {
  currentDesktopTheme = snapshot
  nativeTheme.themeSource = snapshot.source
  if (mainWindow) applyDesktopThemeToWindow(mainWindow, snapshot)
  startupOverlay?.setTheme(snapshot.effective)
  if (options.broadcast !== false) broadcastDesktopTheme(snapshot)
  return snapshot
}

function broadcastDesktopTheme(snapshot: DesktopThemeSnapshot): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send("desktop-theme:event", { type: "theme", snapshot })
}

async function setDesktopThemeSource(input: unknown): Promise<DesktopThemeSnapshot> {
  const source = parseDesktopThemeSource(input)
  await saveDesktopThemeSource(app.getPath("userData"), source)
  return updateDesktopThemeSnapshot(snapshotDesktopTheme(source))
}

function installDesktopThemeNativeListener(): void {
  nativeTheme.on("updated", () => {
    const snapshot = getDesktopThemeSnapshot()
    if (snapshot.source !== "system") return
    updateDesktopThemeSnapshot(snapshotDesktopTheme(snapshot.source))
  })
}

function snapshotDesktopTheme(source: DesktopThemeSnapshot["source"]): DesktopThemeSnapshot {
  return desktopThemeSnapshot(source, nativeTheme.shouldUseDarkColors)
}

async function setStartupStatus(status: DesktopStartupStatus): Promise<void> {
  await startupOverlay?.setStatus(status)
}

async function dismissStartupOverlay(): Promise<void> {
  const overlay = startupOverlay
  if (!overlay) return
  await overlay.dismiss()
  if (startupOverlay === overlay) startupOverlay = null
}

async function ensureMainWindow() {
  if (mainWindow) return
  pendingCreateWindow ??= createWindow().finally(() => {
    pendingCreateWindow = null
  })
  await pendingCreateWindow
}

async function resolveAppURL(): Promise<string> {
  if (!serverManager) throw new Error("Desktop server manager is not initialized")
  try {
    const url = await serverManager.start()
    currentAppURL = url
    return url
  } catch (error) {
    currentAppURL = null
    const details = error instanceof Error ? error.stack || error.message : String(error)
    return desktopErrorPage("Synergy server failed to start", details, getDesktopThemeSnapshot().effective)
  }
}

function startLocalBrowserBroker(): void {
  if (browserBroker || !nativePagePool) return
  const serverUrl =
    process.env.SYNERGY_BROWSER_BROKER_SERVER_URL ??
    (serverManager?.status().mode === "managed" ? serverManager.status().url : null)
  const token = process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET
  if (!serverUrl || !token) return
  browserBrokerOrigin = new URL(serverUrl).origin
  browserBroker = new BrowserHostBrokerClient({ serverUrl, token, nativePool: nativePagePool })
  browserBroker.connect()
}

function registerIpcHandlers() {
  registerNativeViewHandlers("browserNative.attach", async (input) => {
    await nativeViews?.attach(parseBrowserNativeAttach(input))
  })
  registerNativeViewHandlers("browserNative.detach", (input) => {
    const { ownerKey, pageId } = parseBrowserNativePage(input)
    nativeViews?.detach(ownerKey, pageId)
  })
  registerNativeViewHandlers("browserNative.focus", (input) => {
    const { ownerKey, pageId } = parseBrowserNativePage(input)
    nativeViews?.focus(ownerKey, pageId)
  })
  registerNativeViewHandlers("browserNative.resize", (input) => {
    const { ownerKey, pageId, bounds } = parseBrowserNativeResize(input)
    nativeViews?.resize(ownerKey, pageId, bounds)
  })
  registerNativeViewHandlers("browserNative.presentationTicket", (input) => {
    const request = parseBrowserNativePresentationTicket(input)
    const origin = new URL(request.serverUrl).origin
    if (!browserBrokerOrigin || origin !== browserBrokerOrigin) {
      throw new Error("The connected server is not owned by this Desktop Browser Host.")
    }
    return BrowserNativeLease.issue(process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET!, {
      ownerKey: request.ownerKey,
      serverOrigin: origin,
    })
  })

  ipcMain.handle("desktop.server.status", () => serverManager?.status() ?? null)
  ipcMain.handle("desktop.server.restart", async () => {
    if (!serverManager) throw new Error("Desktop server manager is not initialized")
    const url = await serverManager.restart()
    currentAppURL = url
    await mainWindow?.loadURL(url)
    return serverManager.status()
  })
  ipcMain.handle("desktop.update.status", () => updater?.getStatus() ?? null)
  ipcMain.handle("desktop.update.setMode", (_event, input: unknown) => {
    const mode = DesktopUpdateMode.parse(input)
    return updater?.setMode(mode)
  })
  ipcMain.handle("desktop.update.check", (_event, input: unknown) => {
    const manual = typeof input === "object" && input !== null && (input as { manual?: unknown }).manual === true
    return updater?.check({ manual })
  })
  ipcMain.handle("desktop.update.download", () => updater?.download())
  ipcMain.handle("desktop.update.installAndRestart", async () => {
    isUpdateQuit = true
    return updater?.installAndRestart()
  })
  ipcMain.handle("desktop.badge.setState", (event, input: unknown) => {
    applyDesktopUnreadUpdate({
      mainWindow,
      sender: event.sender,
      rawState: input,
      setCount: setDesktopUnreadCount,
    })
  })
  ipcMain.handle("desktop.shell.openExternal", async (_event, input: unknown) => {
    const url = parseExternalUrl(input)
    await shell.openExternal(url)
  })
  ipcMain.handle("desktop.clipboard.writeText", (_event, input: unknown) => {
    const text = parseClipboardWriteText(input)
    clipboard.writeText(text)
    return true
  })
  ipcMain.handle("dialog:select-directory", async (event, input: unknown) => {
    return selectDirectoryWithNativeDialog({
      mainWindow,
      sender: event.sender,
      serverStatus: serverManager?.status(),
      showOpenDialog: dialog.showOpenDialog.bind(dialog),
      rawRequest: input,
    })
  })
  ipcMain.handle("desktop.startup.appReady", async (event) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false
    await dismissStartupOverlay()
    return true
  })
  ipcMain.handle("desktop.theme.get", () => getDesktopThemeSnapshot())
  ipcMain.handle("desktop.theme.set", (_event, input: unknown) => setDesktopThemeSource(input))
  ipcMain.handle("desktop.window.minimize", () => {
    mainWindow?.minimize()
  })
  ipcMain.handle("desktop.window.toggleMaximize", () => {
    if (!mainWindow) return null
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
    return desktopWindowState(mainWindow)
  })
  ipcMain.handle("desktop.window.close", () => {
    mainWindow?.close()
  })
  ipcMain.handle("desktop.window.state", () => (mainWindow ? desktopWindowState(mainWindow) : null))
}

function registerNativeViewHandlers(channel: string, handler: (input: unknown) => unknown | Promise<unknown>) {
  ipcMain.handle(channel, async (event, input: unknown) => {
    if (!mainWindow || event.sender !== mainWindow.webContents)
      throw new Error("Browser native IPC sender is not trusted.")
    return handler(input)
  })
}

function registerProtocolHandler() {
  if (!app.isPackaged && process.env.SYNERGY_DESKTOP_REGISTER_PROTOCOL !== "1") return
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL)
    return
  }
  app.setAsDefaultProtocolClient(DESKTOP_PROTOCOL, process.execPath, [process.argv[1] ?? path.join(dirname, "main.js")])
}

function focusMainWindow() {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function showMainWindow() {
  void (async () => {
    await ensureMainWindow()
    focusMainWindow()
  })().catch((error) => {
    console.error(error)
  })
}

function installDesktopTray(channel: DesktopChannel): void {
  if (!desktopUsesSystemTray(process.platform)) return
  if (desktopTray) return

  const iconPath = desktopIconPath({
    platform: process.platform,
    dirname,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  if (!iconPath) return

  const icon = nativeImage.createFromPath(iconPath)
  if (icon.isEmpty()) {
    runtimeLog("trayIconUnavailable", { iconPath })
    return
  }

  desktopTrayDefaultIcon = icon
  desktopTray = new Tray(icon)
  desktopTray.setToolTip(desktopWindowTitle(channel))
  applyDesktopUnreadState()
  desktopTray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Synergy", click: showMainWindow },
      { label: "Quit Synergy", click: () => app.quit() },
    ]),
  )
  desktopTray.on("click", showMainWindow)
  desktopTray.on("double-click", showMainWindow)
}

function installWindowCloseBehavior(window: BrowserWindow): void {
  window.on("close", (event) => {
    if (
      !desktopShouldHideToTray({
        platform: process.platform,
        trayAvailable: desktopTray !== null,
        isQuitting,
        isUpdateQuit,
      })
    ) {
      return
    }

    event.preventDefault()
    window.hide()
  })
}

function installWindowInputShortcuts(window: BrowserWindow, debug: boolean): void {
  if (!debug) return
  window.webContents.on("before-input-event", (event, input) => {
    const key = input.key.toLowerCase()
    const command = input.control || input.meta
    if (command && key === "r") {
      event.preventDefault()
      window.webContents.reload()
      return
    }
    const devtoolsShortcut =
      (command && input.shift && key === "i") ||
      (process.platform === "darwin" && input.meta && input.alt && key === "i")
    if (!devtoolsShortcut) return
    event.preventDefault()
    window.webContents.toggleDevTools()
  })
}

function installDesktopWindowStateEvents(window: BrowserWindow): void {
  const emit = () => {
    if (window.isDestroyed()) return
    window.webContents.send("desktop-window:event", { type: "state", state: desktopWindowState(window) })
  }
  window.on("maximize", emit)
  window.on("unmaximize", emit)
  window.on("enter-full-screen", emit)
  window.on("leave-full-screen", emit)
  window.on("focus", emit)
  window.on("blur", emit)
}

function desktopLogDir(): string {
  return process.env.SYNERGY_DESKTOP_LOG_DIR ?? path.join(app.getPath("logs"), "desktop")
}

function findDeepLinks(argv: string[]): string[] {
  return argv.filter((arg) => arg.startsWith(`${DESKTOP_PROTOCOL}://`))
}

function handleDeepLinks(urls: string[]) {
  if (!urls.length) return
  focusMainWindow()
  for (const url of urls) mainWindow?.webContents.send("desktop.deepLink", url)
}

app.on("second-instance", (_event, argv) => {
  handleDeepLinks(findDeepLinks(argv))
  focusMainWindow()
})

app.on("open-url", (event, url) => {
  event.preventDefault()
  handleDeepLinks([url])
})

app.on("window-all-closed", () => {
  if (desktopUsesSystemTray(process.platform) && desktopTray) return
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (!mainWindow) void createWindow()
})

updateQuitApp.on("before-quit-for-update", () => {
  isUpdateQuit = true
  isQuitting = true
  setDesktopUnreadCount(0)
})

app.on("before-quit", (event) => {
  setDesktopUnreadCount(0)
  if (isUpdateQuit) return
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  void (async () => {
    const results = await Promise.allSettled([
      browserBroker?.close() ?? Promise.resolve(),
      serverManager?.stop() ?? Promise.resolve(),
    ])
    results.push(...(await Promise.allSettled([nativePagePool?.destroy() ?? Promise.resolve()])))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) {
      runtimeLog("shutdownIncomplete", {
        errors: failures.map((error) => (error instanceof Error ? error.message : String(error))),
      })
    }
    browserBroker = null
    browserBrokerOrigin = null
    app.exit(failures.length ? 1 : 0)
  })()
})

async function start() {
  if (!shouldStart) return
  await app.whenReady()
  await initializeDesktopTheme()
  initializeDesktopUnreadAssets()
  installDesktopThemeNativeListener()
  runtimeLog("appReady", { mode: process.env.SYNERGY_DESKTOP_MODE ?? "desktop" })
  const dockIconPath = desktopDevDockIconPath({
    platform: process.platform,
    dirname,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  if (dockIconPath) app.dock?.setIcon(dockIconPath)

  const channel = desktopChannel(app.isPackaged)
  installSessionSecurity()
  installAppMenu({
    channel,
    debug: isDebugEnabled(channel),
    getMainWindow: () => mainWindow,
  })
  installDesktopTray(channel)
  registerProtocolHandler()
  registerIpcHandlers()
  await ensureMainWindow()
}

void start().catch((error) => {
  console.error(error)
  app.exit(1)
})
