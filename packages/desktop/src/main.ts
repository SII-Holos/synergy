import {
  app,
  BrowserWindow,
  clipboard,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  shell,
  Tray,
  type BrowserWindowConstructorOptions,
} from "electron"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { BrowserNativeViewManager } from "./browser-native-view.js"
import { BrowserWebRTCHost } from "./browser-webrtc-host.js"
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
  parseClipboardWriteText,
  parseExternalUrl,
} from "./ipc-contract.js"
import { installAppMenu } from "./menu.js"
import { DesktopServerManager } from "./server-manager.js"
import { enforceProductionLoading, installSessionSecurity, installWindowSecurity } from "./security.js"
import { desktopStartupPage, startupStatusScript, type DesktopStartupStatus } from "./startup-page.js"
import { DesktopUpdateMode, DesktopUpdater } from "./updater.js"
import { loadWindowState, scheduleWindowStatePersistence } from "./window-state.js"
import {
  desktopDevDockIconPath,
  desktopIconPath,
  desktopShouldHideToTray,
  desktopUsesSystemTray,
  desktopWindowChromeOptions,
  desktopWindowState,
} from "./window-chrome.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const isBrowserHostMode = process.env.SYNERGY_DESKTOP_MODE === "browser-host"

let mainWindow: BrowserWindow | null = null
let nativeViews: BrowserNativeViewManager | null = null
let browserHost: BrowserWebRTCHost | null = null
let serverManager: DesktopServerManager | null = null
let updater: DesktopUpdater | null = null
let desktopTray: Tray | null = null
let currentAppURL: string | null = null
let shouldStart = true
let isQuitting = false
let isUpdateQuit = false
let pendingCreateWindow: Promise<void> | null = null

const updateQuitApp = app as typeof app & {
  on(event: "before-quit-for-update", listener: () => void): typeof app
}

try {
  app.setAppUserModelId(desktopAppUserModelId(desktopChannel(app.isPackaged)))
} catch {
  // AppUserModelId is only meaningful on Windows.
}

if (!isBrowserHostMode && !app.requestSingleInstanceLock()) {
  shouldStart = false
  app.quit()
}

function runtimeLog(message: string, data?: Record<string, unknown>) {
  if (process.env.SYNERGY_DESKTOP_RUNTIME_TEST !== "1") return
  console.log(`[desktop-runtime] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`)
}

runtimeLog("mainLoaded", { argv: process.argv })

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
  const iconPath = desktopIconPath({
    platform: process.platform,
    dirname,
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
  })
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    width: windowState.width,
    height: windowState.height,
    title: desktopWindowTitle(channel),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#111214" : "#f7f7f5",
    ...desktopWindowChromeOptions({
      platform: process.platform,
      dirname,
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    }),
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
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
  runtimeLog("createWindow", { mode, show: process.env.SYNERGY_DESKTOP_SHOW !== "0" })
  if (process.platform !== "darwin") {
    mainWindow.setMenuBarVisibility(false)
  }
  nativeViews = new BrowserNativeViewManager(mainWindow)
  installWindowSecurity(mainWindow, () => currentAppURL)
  enforceProductionLoading(mainWindow.webContents, () => currentAppURL)
  scheduleWindowStatePersistence(mainWindow, app.getPath("userData"))
  installWindowInputShortcuts(mainWindow, isDebugEnabled(channel))
  installDesktopWindowStateEvents(mainWindow)
  installWindowCloseBehavior(mainWindow)

  if (windowState.maximized) mainWindow.maximize()
  if (process.env.SYNERGY_DESKTOP_SHOW !== "0") {
    mainWindow.once("ready-to-show", () => mainWindow?.show())
  }

  mainWindow.on("closed", () => {
    nativeViews?.destroy()
    nativeViews = null
    mainWindow = null
  })

  await mainWindow.loadURL(
    desktopStartupPage({
      chrome: process.platform === "darwin" ? "native" : "custom",
      iconUrl: iconPath ? pathToFileURL(iconPath).toString() : undefined,
    }),
  )
  await setStartupStatus({
    title: mode === "external" ? "Connecting to Synergy" : "Starting local runtime",
    detail:
      mode === "external"
        ? "Opening the configured desktop app surface."
        : "Synergy is opening the local server and workspace.",
  })

  const targetURL = await resolveAppURL()
  await setStartupStatus({
    title: currentAppURL ? "Loading workspace" : "Startup needs attention",
    detail: currentAppURL
      ? "Connecting to the local app surface."
      : "Synergy could not start the local runtime. Opening diagnostics.",
  })
  await mainWindow.loadURL(targetURL)
  runtimeLog("windowLoaded", { url: mainWindow.webContents.getURL() })
}

async function setStartupStatus(status: DesktopStartupStatus): Promise<void> {
  const window = mainWindow
  if (!window || window.isDestroyed()) return
  if (!window.webContents.getURL().startsWith("data:text/html,")) return
  await window.webContents.executeJavaScript(startupStatusScript(status)).catch(() => {})
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
    return desktopErrorPage("Synergy server failed to start", details)
  }
}

async function createBrowserHost() {
  const serverUrl = process.env.SYNERGY_BROWSER_HOST_SERVER_URL
  const sessionID = process.env.SYNERGY_BROWSER_HOST_SESSION_ID
  const pageId = process.env.SYNERGY_BROWSER_HOST_PAGE_ID

  if (!serverUrl || !sessionID || !pageId) {
    throw new Error("Browser Host mode requires SYNERGY_BROWSER_HOST_SERVER_URL, SESSION_ID, and PAGE_ID")
  }

  runtimeLog("createBrowserHost", {
    serverUrl,
    sessionID,
    pageId,
    routeDirectory: process.env.SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY,
  })
  browserHost = new BrowserWebRTCHost({
    serverUrl,
    sessionID,
    pageId,
    routeDirectory: process.env.SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY,
    directory: process.env.SYNERGY_BROWSER_HOST_DIRECTORY,
    scopeID: process.env.SYNERGY_BROWSER_HOST_SCOPE_ID,
    scopeKey: process.env.SYNERGY_BROWSER_HOST_SCOPE_KEY,
    url: process.env.SYNERGY_BROWSER_HOST_URL,
    width: Number(process.env.SYNERGY_BROWSER_HOST_WIDTH ?? 1280),
    height: Number(process.env.SYNERGY_BROWSER_HOST_HEIGHT ?? 720),
    traceId: process.env.SYNERGY_BROWSER_HOST_TRACE_ID,
  })
  await browserHost.start()
}

function registerIpcHandlers() {
  registerNativeViewHandlers("browserNative.attach", async (input) => {
    await nativeViews?.attach(parseBrowserNativeAttach(input))
  })
  registerNativeViewHandlers("browserNative.detach", (input) => {
    const { pageId } = parseBrowserNativePage(input)
    nativeViews?.detach(pageId)
  })
  registerNativeViewHandlers("browserNative.focus", (input) => {
    const { pageId } = parseBrowserNativePage(input)
    nativeViews?.focus(pageId)
  })
  registerNativeViewHandlers("browserNative.resize", (input) => {
    const { pageId, bounds } = parseBrowserNativeResize(input)
    nativeViews?.resize(pageId, bounds)
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
  ipcMain.handle("desktop.shell.openExternal", async (_event, input: unknown) => {
    const url = parseExternalUrl(input)
    await shell.openExternal(url)
  })
  ipcMain.handle("desktop.clipboard.writeText", (_event, input: unknown) => {
    const text = parseClipboardWriteText(input)
    clipboard.writeText(text)
    return true
  })
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

function registerNativeViewHandlers(channel: string, handler: (input: unknown) => void | Promise<void>) {
  ipcMain.handle(channel, async (_event, input: unknown) => handler(input))
}

function registerProtocolHandler() {
  if (isBrowserHostMode) return
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

  desktopTray = new Tray(icon)
  desktopTray.setToolTip(desktopWindowTitle(channel))
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

function configureBrowserHostVisibility() {
  if (process.platform !== "darwin") return
  app.dock?.hide()
  app.setActivationPolicy("accessory")
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
  if (isBrowserHostMode) return
  if (!mainWindow) void createWindow()
})

updateQuitApp.on("before-quit-for-update", () => {
  isUpdateQuit = true
  isQuitting = true
})

app.on("before-quit", (event) => {
  browserHost?.destroy()
  browserHost = null
  if (isUpdateQuit) return
  if (isQuitting) return
  event.preventDefault()
  isQuitting = true
  const shutdown = serverManager?.stop() ?? Promise.resolve()
  void shutdown.finally(() => app.exit(0))
})

async function start() {
  if (!shouldStart) return
  await app.whenReady()
  runtimeLog("appReady", { mode: process.env.SYNERGY_DESKTOP_MODE ?? "desktop" })
  if (isBrowserHostMode) {
    configureBrowserHostVisibility()
    await createBrowserHost()
    return
  }

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
