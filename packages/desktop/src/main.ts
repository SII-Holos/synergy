import { app, BrowserWindow, ipcMain, shell } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  BrowserNativeViewManager,
  type BrowserNativeAttachRequest,
  type BrowserNativeBounds,
} from "./browser-native-view.js"
import { BrowserWebRTCHost } from "./browser-webrtc-host.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const appURL = process.env.SYNERGY_DESKTOP_APP_URL ?? "http://localhost:3000"

let mainWindow: BrowserWindow | null = null
let nativeViews: BrowserNativeViewManager | null = null
let browserHost: BrowserWebRTCHost | null = null

function runtimeLog(message: string, data?: Record<string, unknown>) {
  if (process.env.SYNERGY_DESKTOP_RUNTIME_TEST !== "1") return
  console.log(`[desktop-runtime] ${message}${data ? ` ${JSON.stringify(data)}` : ""}`)
}

runtimeLog("mainLoaded", { argv: process.argv })

async function createWindow() {
  runtimeLog("createWindow", { appURL, show: process.env.SYNERGY_DESKTOP_SHOW !== "0" })
  mainWindow = new BrowserWindow({
    show: process.env.SYNERGY_DESKTOP_SHOW !== "0",
    width: 1440,
    height: 920,
    title: "Synergy",
    backgroundColor: "#111214",
    webPreferences: {
      preload: path.join(dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  nativeViews = new BrowserNativeViewManager(mainWindow)

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: "deny" }
  })

  mainWindow.on("closed", () => {
    nativeViews?.destroy()
    nativeViews = null
    mainWindow = null
  })

  await mainWindow.loadURL(appURL)
  runtimeLog("windowLoaded", { url: mainWindow.webContents.getURL() })
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

ipcMain.handle("browser-native:attach", async (_event, input: BrowserNativeAttachRequest) => {
  await nativeViews?.attach(input)
})

ipcMain.handle("browser-native:detach", (_event, input: { tabId: string }) => {
  nativeViews?.detach(input.tabId)
})

ipcMain.handle("browser-native:focus", (_event, input: { tabId: string }) => {
  nativeViews?.focus(input.tabId)
})

ipcMain.handle("browser-native:resize", (_event, input: { tabId: string; bounds: BrowserNativeBounds }) => {
  nativeViews?.resize(input.tabId, input.bounds)
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})

app.on("activate", () => {
  if (process.env.SYNERGY_DESKTOP_MODE === "browser-host") return
  if (!mainWindow) void createWindow()
})

app.on("before-quit", () => {
  browserHost?.destroy()
  browserHost = null
})

async function start() {
  await app.whenReady()
  runtimeLog("appReady", { mode: process.env.SYNERGY_DESKTOP_MODE ?? "desktop" })
  if (process.env.SYNERGY_DESKTOP_MODE === "browser-host") {
    await createBrowserHost()
  } else {
    await createWindow()
  }
}

void start().catch((error) => {
  console.error(error)
  app.exit(1)
})
