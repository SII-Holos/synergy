import { Hono } from "hono"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { BlueprintRoute } from "./blueprint/routes/blueprint"
import { BlueprintLoopSources } from "./blueprint/source"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["blueprint", ...(BlueprintLoopSources.available("plugin") ? ["plugin-blueprint"] : [])],
      routes: { "scoped-before-assets": new Hono().route("/blueprint", BlueprintRoute()) },
      isScopeRequiredRoute: (pathname) => pathname === "/blueprint" || pathname.startsWith("/blueprint/"),
    },
    "blueprint",
  )
}
