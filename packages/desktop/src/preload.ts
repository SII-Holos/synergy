import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import type { BrowserNativeAttachRequest, BrowserNativeBounds, BrowserNativeViewEvent } from "./browser-native-view.js"

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
  onEvent(listener: (event: BrowserNativeViewEvent) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: BrowserNativeViewEvent) => listener(payload)
    ipcRenderer.on("browser-native:event", wrapped)
    return () => ipcRenderer.off("browser-native:event", wrapped)
  },
}

contextBridge.exposeInMainWorld("synergyDesktop", {
  platform: "desktop",
  browserNative,
})
