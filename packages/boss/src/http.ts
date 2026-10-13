import { Hono } from "hono"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { BossRoute } from "./boss/routes/boss"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["boss"],
      routes: { "scoped-before-assets": new Hono().route("/boss", BossRoute()) },
      isScopeRequiredRoute: (pathname) => pathname === "/boss" || pathname.startsWith("/boss/"),
    },
    "boss",
  )
}
