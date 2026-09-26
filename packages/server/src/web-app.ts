import path from "node:path"
import { version } from "../package.json" with { type: "json" }
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { Server } from "./server/server"
import { mountApp } from "./server/app-static"

export function webApp(options: { directory: string }): RuntimeComponent {
  const directory = path.resolve(options.directory)
  return {
    id: "web-app",
    apiVersion: 1,
    version,
    requires: { server: version },
    register() {
      Server.registerContributions({ mountApp: (app) => mountApp(app, directory) }, "web-app")
    },
  }
}
