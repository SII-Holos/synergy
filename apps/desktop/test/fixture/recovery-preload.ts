import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("synergyDesktop", {
  window: Object.fromEntries(
    ["minimize", "toggleMaximize", "close", "state"].map((action) => [
      action,
      () => ipcRenderer.invoke(`fixture.window.${action}`),
    ]),
  ),
  server: Object.fromEntries(
    ["status", "restart", "maintenance", "cancelMaintenance", "diagnostics"].map((action) => [
      action,
      () => ipcRenderer.invoke(`fixture.recovery.${action}`),
    ]),
  ),
})
