import { app, BrowserWindow, ipcMain, shell, type BrowserWindowConstructorOptions } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  BrowserNativeViewManager,
  type BrowserNativeAttachRequest,
  type BrowserNativeBounds,
} from "./browser-native-view.js"
import { BrowserWebRTCHost } from "./browser-webrtc-host.js"
import { desktopErrorPage } from "./error-page.js"
import {
  DESKTOP_APP_ID,
  DESKTOP_PROTOCOL,
  desktopChannel,
  desktopServerMode,
  desktopWindowTitle,
  isDebugEnabled,
} from "./identity.js"
import {
  parseBrowserNativeAttach,
  parseBrowserNativeResize,
  parseBrowserNativeTab,
  parseExternalUrl,
} from "./ipc-contract.js"
import { installAppMenu } from "./menu.js"
import { DesktopServerManager } from "./server-manager.js"
import { enforceProductionLoading, installSessionSecurity, installWindowSecurity } from "./security.js"
import { DesktopUpdater } from "./updater.js"
import { loadWindowState, scheduleWindowStatePersistence } from "./window-state.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const isBrowserHostMode = process.env.SYNERGY_DESKTOP_MODE === "browser-host"

let mainWindow: BrowserWindow | null = null
let nativeViews: BrowserNativeViewManager | null = null
let browserHost: BrowserWebRTCHost | null = null
let serverManager: DesktopServerManager | null = null
let updater: DesktopUpdater | null = null
let currentAppURL: string | null = null
let shouldStart = true
let isQuitting = false

try {
  app.setAppUserModelId(DESKTOP_APP_ID)
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
  updater ??= new DesktopUpdater(channel)
  serverManager ??= new DesktopServerManager({
    channel,
    mode,
    resourcesPath: process.resourcesPath,
    logDir: desktopLogDir(),
    externalUrl: process.env.SYNERGY_DESKTOP_APP_URL,
  })

  const targetURL = await resolveAppURL()
  runtimeLog("createWindow", { targetURL, mode, show: process.env.SYNERGY_DESKTOP_SHOW !== "0" })

  const windowState = await loadWindowState(app.getPath("userData"))
  const windowOptions: BrowserWindowConstructorOptions = {
    show: false,
    width: windowState.width,
    height: windowState.height,
    title: desktopWindowTitle(channel),
    backgroundColor: "#111214",
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
  nativeViews = new BrowserNativeViewManager(mainWindow)
  installWindowSecurity(mainWindow, () => currentAppURL)
  enforceProductionLoading(mainWindow.webContents, currentAppURL)
  scheduleWindowStatePersistence(mainWindow, app.getPath("userData"))

  if (windowState.maximized) mainWindow.maximize()
  if (process.env.SYNERGY_DESKTOP_SHOW !== "0") {
    mainWindow.once("ready-to-show", () => mainWindow?.show())
  }

  mainWindow.on("closed", () => {
    nativeViews?.destroy()
    nativeViews = null
    mainWindow = null
  })

  await mainWindow.loadURL(targetURL)
  runtimeLog("windowLoaded", { url: mainWindow.webContents.getURL() })
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
  const tabId = process.env.SYNERGY_BROWSER_HOST_TAB_ID

  if (!serverUrl || !sessionID || !tabId) {
    throw new Error("Browser Host mode requires SYNERGY_BROWSER_HOST_SERVER_URL, SESSION_ID, and TAB_ID")
  }

  runtimeLog("createBrowserHost", {
    serverUrl,
    sessionID,
    tabId,
    routeDirectory: process.env.SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY,
  })
  browserHost = new BrowserWebRTCHost({
    serverUrl,
    sessionID,
    tabId,
    routeDirectory: process.env.SYNERGY_BROWSER_HOST_ROUTE_DIRECTORY,
    directory: process.env.SYNERGY_BROWSER_HOST_DIRECTORY,
    scopeID: process.env.SYNERGY_BROWSER_HOST_SCOPE_ID,
    scopeKey: process.env.SYNERGY_BROWSER_HOST_SCOPE_KEY,
    url: process.env.SYNERGY_BROWSER_HOST_URL,
    width: Number(process.env.SYNERGY_BROWSER_HOST_WIDTH ?? 1280),
    height: Number(process.env.SYNERGY_BROWSER_HOST_HEIGHT ?? 720),
  })
  await browserHost.start()
}

function registerIpcHandlers() {
  registerNativeViewHandlers("browserNative.attach", async (input) => {
    await nativeViews?.attach(parseBrowserNativeAttach(input))
  })
  registerNativeViewHandlers("browserNative.detach", (input) => {
    const { tabId } = parseBrowserNativeTab(input)
    nativeViews?.detach(tabId)
  })
  registerNativeViewHandlers("browserNative.focus", (input) => {
    const { tabId } = parseBrowserNativeTab(input)
    nativeViews?.focus(tabId)
  })
  registerNativeViewHandlers("browserNative.resize", (input) => {
    const { tabId, bounds } = parseBrowserNativeResize(input)
    nativeViews?.resize(tabId, bounds)
  })

  ipcMain.handle("browser-native:attach", async (_event, input: BrowserNativeAttachRequest) => {
    await nativeViews?.attach(parseBrowserNativeAttach(input))
  })
  ipcMain.handle("browser-native:detach", (_event, input: { tabId: string }) => {
    const { tabId } = parseBrowserNativeTab(input)
    nativeViews?.detach(tabId)
  })
  ipcMain.handle("browser-native:focus", (_event, input: { tabId: string }) => {
    const { tabId } = parseBrowserNativeTab(input)
    nativeViews?.focus(tabId)
  })
  ipcMain.handle("browser-native:resize", (_event, input: { tabId: string; bounds: BrowserNativeBounds }) => {
    const { tabId, bounds } = parseBrowserNativeResize(input)
    nativeViews?.resize(tabId, bounds)
  })

  ipcMain.handle("desktop.server.status", () => serverManager?.status() ?? null)
  ipcMain.handle("desktop.server.restart", async () => {
    if (!serverManager) throw new Error("Desktop server manager is not initialized")
    const url = await serverManager.restart()
    currentAppURL = url
    await mainWindow?.loadURL(url)
    return serverManager.status()
  })
  ipcMain.handle("desktop.update.check", () => updater?.check())
  ipcMain.handle("desktop.update.installAndRestart", () => {
    updater?.installAndRestart()
  })
  ipcMain.handle("desktop.shell.openExternal", async (_event, input: unknown) => {
    const url = parseExternalUrl(input)
    await shell.openExternal(url)
  })
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
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (isBrowserHostMode) return
  if (!mainWindow) void createWindow()
})

app.on("before-quit", (event) => {
  browserHost?.destroy()
  browserHost = null
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

  const channel = desktopChannel(app.isPackaged)
  installSessionSecurity()
  installAppMenu({
    channel,
    debug: isDebugEnabled(channel),
    getMainWindow: () => mainWindow,
  })
  registerProtocolHandler()
  registerIpcHandlers()
  await createWindow()
}

void start().catch((error) => {
  console.error(error)
  app.exit(1)
})
