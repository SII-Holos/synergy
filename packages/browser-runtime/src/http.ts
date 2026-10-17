import { BrowserRoute } from "./routes/browser-route"
import { configureBrowserViewerOrigins } from "./routes/browser-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      features: ["browser"],
      routes: { "scoped-after-assets": new Hono().route("", BrowserRoute()) },
      configureOrigins: configureBrowserViewerOrigins,
    },
    "browser-runtime",
  )
}
