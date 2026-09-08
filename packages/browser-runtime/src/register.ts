import { MigrationRegistry } from "@ericsanchezok/synergy-harness/migration/registry"
import { migrations } from "./migration"
import { registerBrowserTools } from "./tools"
import "./command-service"
import { BrowserRuntime } from "./runtime"

let registered = false

export function registerBrowser() {
  if (registered) return
  MigrationRegistry.register("browser", migrations)
  registerBrowserTools()
  registered = true
}

export async function disposeBrowser() {
  await BrowserRuntime.stop()
}
