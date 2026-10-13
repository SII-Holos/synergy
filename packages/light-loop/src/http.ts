import { Hono } from "hono"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { LightLoopRoute } from "./routes/workflow"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["light-loop"],
      routes: { "scoped-before-assets": new Hono().route("/workflow", LightLoopRoute()) },
      isScopeRequiredRoute: (pathname) => pathname === "/workflow" || pathname.startsWith("/workflow/"),
    },
    "light-loop",
  )
}
