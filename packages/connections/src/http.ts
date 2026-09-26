import { GithubIdentityRoute } from "./github/routes"
import { ManagedProjectArchiveError } from "./channel/managed-project-ownership"
import { ChannelRoute } from "./channel/routes/channel"
import { HolosRoute } from "./holos/routes/holos"
import { HolosDataRoute } from "./holos/routes/holos"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "global-services": new Hono().route("/holos", HolosRoute()),
        "scoped-after-assets": new Hono().route("/holos", HolosDataRoute()),
        "scoped-integrations": new Hono().route("/channel", ChannelRoute()),
      },
      providerRoutes: GithubIdentityRoute(),
      scopeConflictSchema: ManagedProjectArchiveError.Schema,
      isGlobalRoute: (pathname) => matchesPath(pathname, ["/holos", "/channel"]),
      errorStatus: (error) => {
        if (error instanceof ManagedProjectArchiveError) return 409
        if (error.name === "ChannelStartError") return 400
      },
    },
    "connections",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
