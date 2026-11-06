import { Server } from "@ericsanchezok/synergy-server/server/server"
export function registerHttp() {
  Server.registerContributions({ features: ["channel-github"] }, "channel-github")
}
