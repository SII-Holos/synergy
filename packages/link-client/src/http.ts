import { SynergyLinkRoute } from "./routes/synergy-link-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "global-services": new Hono().route("/synergy-link", SynergyLinkRoute()) },
      isGlobalRoute: (pathname) => matchesPath(pathname, ["/synergy-link"]),
    },
    "link-client",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
