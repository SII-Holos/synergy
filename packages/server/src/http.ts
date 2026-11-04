import { BusEvent } from "@ericsanchezok/synergy-harness/bus/bus-event"
import { GlobalNavRoute } from "./server/global-nav"
import { Server } from "./server/server"
import { Hono } from "hono"

export function registerHttp() {
  BusEvent.register(...Object.values(Server.Event))
  Server.registerContributions(
    {
      features: ["session-long-term-memory"],
      routes: { "global-navigation": new Hono().route("/global", GlobalNavRoute()) },
    },
    "server",
  )
}
