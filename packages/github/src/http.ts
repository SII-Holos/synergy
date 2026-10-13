import { Server } from "@ericsanchezok/synergy-server/server/server"
import { GithubIdentityRoute } from "./github/routes"
export function registerHttp() {
  Server.registerContributions({ features: ["github"], providerRoutes: GithubIdentityRoute() }, "github")
}
