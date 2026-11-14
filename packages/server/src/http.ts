import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { GlobalNavRoute } from "./server/global-nav"
import { Server } from "./server/server"
import { Hono } from "hono"
import { registerWorkspaceRequests } from "./server/workspace-context"

export function registerHttp() {
  registerWorkspaceRequests()
  BusEvent.register(...Object.values(Server.Event))
  Server.registerContributions(
    {
      features: ["session-long-term-memory"],
      routes: { "global-navigation": new Hono().route("/global", GlobalNavRoute()) },
    },
    "server",
  )
}
