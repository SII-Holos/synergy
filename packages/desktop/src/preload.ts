import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { BrowserNativeAttachRequest, BrowserNativeBounds, BrowserNativeViewEvent } from "./browser-native-view.js"
import type { DesktopUpdateEvent, DesktopUpdateMode } from "./updater.js"
import type { DesktopWindowState } from "./window-chrome.js"

const browserNative = {
  attachView(input: BrowserNativeAttachRequest) {
    return ipcRenderer.invoke("browserNative.attach", input) as Promise<void>
  },
  detachView(input: { pageId: string }) {
    return ipcRenderer.invoke("browserNative.detach", input) as Promise<void>
  },
  focusView(input: { pageId: string }) {
    return ipcRenderer.invoke("browserNative.focus", input) as Promise<void>
  },
  resizeView(input: { pageId: string; width: number; height: number; x?: number; y?: number }) {
    const bounds: BrowserNativeBounds = {
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width,
      height: input.height,
    }
    return ipcRenderer.invoke("browserNative.resize", { pageId: input.pageId, bounds }) as Promise<void>
  },
  onEvent(listener: (event: BrowserNativeViewEvent) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: BrowserNativeViewEvent) => listener(payload)
    ipcRenderer.on("browser-native:event", wrapped)
    return () => ipcRenderer.off("browser-native:event", wrapped)
  },
}

const server = {
  status() {
    return ipcRenderer.invoke("desktop.server.status")
  },
  restart() {
    return ipcRenderer.invoke("desktop.server.restart")
  },
}

const update = {
  status() {
    return ipcRenderer.invoke("desktop.update.status")
  },
  setMode(mode: DesktopUpdateMode) {
    return ipcRenderer.invoke("desktop.update.setMode", mode)
  },
  check(input?: { manual?: boolean }) {
    return ipcRenderer.invoke("desktop.update.check", input ?? {})
  },
  download() {
    return ipcRenderer.invoke("desktop.update.download")
  },
  installAndRestart() {
    return ipcRenderer.invoke("desktop.update.installAndRestart")
  },
  onEvent(listener: (event: DesktopUpdateEvent) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopUpdateEvent) => listener(payload)
    ipcRenderer.on("desktop-update:event", wrapped)
    return () => ipcRenderer.off("desktop-update:event", wrapped)
  },
}

const desktopShell = {
  openExternal(url: string) {
    return ipcRenderer.invoke("desktop.shell.openExternal", url) as Promise<void>
  },
}

const desktopClipboard = {
  writeText(text: string) {
    return ipcRenderer.invoke("desktop.clipboard.writeText", text) as Promise<boolean>
  },
}

const desktopWindow = {
  chrome: process.platform === "darwin" ? "native" : "custom",
  minimize() {
    return ipcRenderer.invoke("desktop.window.minimize") as Promise<void>
  },
  toggleMaximize() {
    return ipcRenderer.invoke("desktop.window.toggleMaximize") as Promise<DesktopWindowState | null>
  },
  close() {
    return ipcRenderer.invoke("desktop.window.close") as Promise<void>
  },
  state() {
    return ipcRenderer.invoke("desktop.window.state") as Promise<DesktopWindowState | null>
  },
  onEvent(listener: (event: { type: "state"; state: DesktopWindowState }) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: { type: "state"; state: DesktopWindowState }) =>
      listener(payload)
    ipcRenderer.on("desktop-window:event", wrapped)
    return () => ipcRenderer.off("desktop-window:event", wrapped)
  },
}

contextBridge.exposeInMainWorld("synergyDesktop", {
  platform: "desktop",
  server,
  update,
  shell: desktopShell,
  clipboard: desktopClipboard,
  window: desktopWindow,
  browserNative,
})
