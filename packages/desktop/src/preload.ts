import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { BrowserNativeAttachRequest, BrowserNativeBounds, BrowserNativeViewEvent } from "./browser-native-view.js"

const browserNative = {
  attachView(input: BrowserNativeAttachRequest) {
    return ipcRenderer.invoke("browserNative.attach", input) as Promise<void>
  },
  detachView(input: { tabId: string }) {
    return ipcRenderer.invoke("browserNative.detach", input) as Promise<void>
  },
  focusView(input: { tabId: string }) {
    return ipcRenderer.invoke("browserNative.focus", input) as Promise<void>
  },
  resizeView(input: { tabId: string; width: number; height: number; x?: number; y?: number }) {
    const bounds: BrowserNativeBounds = {
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width,
      height: input.height,
    }
    return ipcRenderer.invoke("browserNative.resize", { tabId: input.tabId, bounds }) as Promise<void>
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
  check() {
    return ipcRenderer.invoke("desktop.update.check")
  },
  installAndRestart() {
    return ipcRenderer.invoke("desktop.update.installAndRestart")
  },
}

const desktopShell = {
  openExternal(url: string) {
    return ipcRenderer.invoke("desktop.shell.openExternal", url) as Promise<void>
  },
}

contextBridge.exposeInMainWorld("synergyDesktop", {
  platform: "desktop",
  server,
  update,
  shell: desktopShell,
  browserNative,
})
