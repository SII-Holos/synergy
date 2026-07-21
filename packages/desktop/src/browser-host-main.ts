import { app, nativeTheme } from "electron"
import { BrowserHostBrokerClient } from "./browser-host-broker.js"
import { defaultDesktopSkinState, desktopThemeSnapshot } from "./theme.js"

let broker: BrowserHostBrokerClient | null = null

app.on("window-all-closed", () => {})
app.on("before-quit", () => void broker?.close())
process.once("SIGTERM", () => app.quit())
process.once("SIGINT", () => app.quit())

void start().catch((error) => {
  console.error("Browser Host failed to start:", error instanceof Error ? error.message : String(error))
  app.exit(1)
})

async function start(): Promise<void> {
  await app.whenReady()
  const serverUrl = process.env.SYNERGY_BROWSER_HOST_SERVER_URL
  const token = process.env.SYNERGY_BROWSER_HOST_REGISTRATION_SECRET
  if (!serverUrl || !token) throw new Error("Browser Host requires server URL and registration secret.")
  broker = new BrowserHostBrokerClient({
    serverUrl,
    token,
    theme: desktopThemeSnapshot(defaultDesktopSkinState(), nativeTheme.shouldUseDarkColors),
  })
  broker.connect()
}
