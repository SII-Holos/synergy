import { GlobalNavRoute } from "./server/global-nav"
import { Server } from "./server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "global-navigation": new Hono().route("/global", GlobalNavRoute()) },
    },
    "server",
  )
}
