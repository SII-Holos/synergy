import { app, BrowserWindow, ipcMain, shell } from "electron"
import path from "node:path"
import { fileURLToPath } from "node:url"
import {
  BrowserNativeViewManager,
  type BrowserNativeAttachRequest,
  type BrowserNativeBounds,
} from "./browser-native-view.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))
const appURL = process.env.SYNERGY_DESKTOP_APP_URL ?? "http://localhost:3000"

let mainWindow: BrowserWindow | null = null
let nativeViews: BrowserNativeViewManager | null = null

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    title: "Synergy",
    backgroundColor: "#111214",
    webPreferences: {
      preload: path.join(dirname, "preload.js"),
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
  if (!mainWindow) void createWindow()
})

await app.whenReady()
await createWindow()
