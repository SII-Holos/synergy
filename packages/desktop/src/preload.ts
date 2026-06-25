import { contextBridge, ipcRenderer } from "electron"
import type { BrowserNativeAttachRequest, BrowserNativeBounds } from "./browser-native-view.js"

const browserNative = {
  attachView(input: BrowserNativeAttachRequest) {
    return ipcRenderer.invoke("browser-native:attach", input) as Promise<void>
  },
  detachView(input: { tabId: string }) {
    return ipcRenderer.invoke("browser-native:detach", input) as Promise<void>
  },
  focusView(input: { tabId: string }) {
    return ipcRenderer.invoke("browser-native:focus", input) as Promise<void>
  },
  resizeView(input: { tabId: string; width: number; height: number; x?: number; y?: number }) {
    const bounds: BrowserNativeBounds = {
      x: input.x ?? 0,
      y: input.y ?? 0,
      width: input.width,
      height: input.height,
    }
    return ipcRenderer.invoke("browser-native:resize", { tabId: input.tabId, bounds }) as Promise<void>
  },
}

contextBridge.exposeInMainWorld("synergyDesktop", {
  platform: "desktop",
  browserNative,
})
