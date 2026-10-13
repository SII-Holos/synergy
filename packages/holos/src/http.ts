import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { HolosRoute, HolosDataRoute } from "./holos/routes/holos"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["holos"],
      routes: {
        "global-services": new Hono().route("/holos", HolosRoute()),
        "scoped-after-assets": new Hono().route("/holos", HolosDataRoute()),
      },
      isGlobalRoute: (pathname) => pathname === "/holos" || pathname.startsWith("/holos/"),
    },
    "holos",
  )
}
