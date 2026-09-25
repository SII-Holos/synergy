import { PluginRoute } from "./plugin/routes/plugin-routes"
import { ApiPluginRoute } from "./plugin/routes/plugin-routes"
import { PluginRuntimeRoute } from "./plugin-runtime/routes/plugin-runtime-routes"
import { RegistryRoute } from "./plugin/routes/plugin-registry-routes"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: {
        "scoped-after-assets": new Hono()
          .route("/plugin", PluginRoute())
          .route("/api/plugins", ApiPluginRoute())
          .route("/api/plugins", PluginRuntimeRoute())
          .route("/api/registry", RegistryRoute()),
      },
      isGlobalRoute: (pathname) =>
        pathname === "/plugin/ui/contributions/themes" ||
        matchesPath(pathname, ["/plugin/assets", "/api/plugins", "/api/registry"]),
    },
    "plugin-host",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
