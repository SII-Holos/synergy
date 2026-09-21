import { contextBridge, ipcRenderer } from "electron"

contextBridge.exposeInMainWorld("synergyDesktop", {
  server: Object.fromEntries(
    ["status", "restart", "maintenance", "cancelMaintenance", "diagnostics"].map((action) => [
      action,
      () => ipcRenderer.invoke(`fixture.recovery.${action}`),
    ]),
  ),
})
