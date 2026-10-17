import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { ChannelRoute } from "./channel/routes/channel"
import { ManagedProjectArchiveError } from "./channel/managed-project-ownership"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["channels"],
      routes: { "scoped-integrations": new Hono().route("/channel", ChannelRoute()) },
      scopeConflictSchema: ManagedProjectArchiveError.Schema,
      isGlobalRoute: (pathname) => pathname === "/channel" || pathname.startsWith("/channel/"),
      errorStatus: (error) =>
        error instanceof ManagedProjectArchiveError ? 409 : error.name === "ChannelStartError" ? 400 : undefined,
    },
    "channels",
  )
}
