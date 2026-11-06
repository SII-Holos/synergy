import { contextBridge, ipcRenderer } from "electron"

// Electron replaces Chromium's prompt with an unsupported stub. Keep its synchronous
// return contract across isolated worlds: https://www.electronjs.org/docs/latest/api/context-bridge
contextBridge.executeInMainWorld({
  func: (prompt: typeof window.prompt) => {
    window.prompt = prompt
  },
  args: [
    (message: unknown = "", defaultValue: unknown = ""): string | null => {
      const result: unknown = ipcRenderer.sendSync("synergy:browser:prompt", {
        message: String(message).slice(0, 100_000),
        defaultValue: String(defaultValue).slice(0, 100_000),
      })
      return typeof result === "string" ? result : null
    },
  ],
})
