import path from "node:path"
import { existsSync, realpathSync } from "node:fs"
import { webApp } from "@ericsanchezok/synergy-server/web-app"

export function presetWebApp() {
  const installed = path.resolve(path.dirname(realpathSync(process.execPath)), "../app")
  return webApp({
    directory: existsSync(installed) ? installed : path.resolve(import.meta.dirname, "../../../../apps/web/dist"),
  })
}
