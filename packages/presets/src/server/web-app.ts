import path from "node:path"
import { webApp } from "@ericsanchezok/synergy-server/web-app"

export function sourceWebApp() {
  return webApp({
    directory: path.resolve(import.meta.dirname, "../../../../apps/web/dist"),
  })
}
