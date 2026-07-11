import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron"
import {
  BrowserNativeViewEventSchema,
  type BrowserNativeAttachRequest,
  type BrowserNativePageRequest,
  type BrowserNativePresentationTicketRequest,
  type BrowserNativeResizeRequest,
  type BrowserNativeViewEvent,
} from "@ericsanchezok/synergy-browser"
import type { DesktopUpdateEvent, DesktopUpdateMode } from "./updater.js"
import type { DesktopWindowState } from "./window-chrome.js"
import { mapSelectDirectoryDialogResponse, type SelectDirectoryDialogBridgeResponse } from "./directory-picker.js"
import type { DesktopThemeEvent, DesktopThemeSnapshot, DesktopThemeSource } from "./theme.js"

const browserNative = {
  attachView(input: BrowserNativeAttachRequest) {
    return ipcRenderer.invoke("browserNative.attach", input) as Promise<void>
  },
  detachView(input: BrowserNativePageRequest) {
    return ipcRenderer.invoke("browserNative.detach", input) as Promise<void>
  },
  focusView(input: BrowserNativePageRequest) {
    return ipcRenderer.invoke("browserNative.focus", input) as Promise<void>
  },
  resizeView(input: BrowserNativeResizeRequest) {
    return ipcRenderer.invoke("browserNative.resize", input) as Promise<void>
  },
  createPresentationTicket(input: BrowserNativePresentationTicketRequest) {
    return ipcRenderer.invoke("browserNative.presentationTicket", input) as Promise<string>
  },
  onEvent(listener: (event: BrowserNativeViewEvent) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: unknown) => {
      const event = BrowserNativeViewEventSchema.safeParse(payload)
      if (event.success) listener(event.data)
    }
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

function openDirectoryPickerDialog(opts?: { title?: string; multiple?: boolean }): Promise<string | string[] | null> {
  const multiple = opts?.multiple ?? false
  return ipcRenderer
    .invoke("dialog:select-directory", { title: opts?.title, multiple })
    .then((response: SelectDirectoryDialogBridgeResponse) => mapSelectDirectoryDialogResponse(response, multiple))
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

const desktopStartup = {
  appReady() {
    return ipcRenderer.invoke("desktop.startup.appReady") as Promise<boolean>
  },
}

const desktopTheme = {
  get() {
    return ipcRenderer.invoke("desktop.theme.get") as Promise<DesktopThemeSnapshot | null>
  },
  set(source: DesktopThemeSource) {
    return ipcRenderer.invoke("desktop.theme.set", source) as Promise<DesktopThemeSnapshot | null>
  },
  onEvent(listener: (event: DesktopThemeEvent) => void) {
    const wrapped = (_event: IpcRendererEvent, payload: DesktopThemeEvent) => listener(payload)
    ipcRenderer.on("desktop-theme:event", wrapped)
    return () => ipcRenderer.off("desktop-theme:event", wrapped)
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
  openDirectoryPickerDialog,
  server,
  update,
  shell: desktopShell,
  clipboard: desktopClipboard,
  startup: desktopStartup,
  theme: desktopTheme,
  window: desktopWindow,
  browserNative,
})
