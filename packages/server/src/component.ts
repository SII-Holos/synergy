import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { Server } from "./server/server"
import { registerHttp } from "./http"

export function server(): RuntimeComponent {
  return {
    id: "server",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    hosts: ["http"],
    register: registerHttp,
    services: () => ({
      transport: {
        listen(network, mode) {
          if (mode === "server") Server.mountApp()
          Server.resumeRequests()
          return Server.listen({ ...network, preferDefaultPort: mode === "server" })
        },
        closeAdmission: () => Server.beginShutdown(),
      },
    }),
  }
}
