import { BrowserRoute } from "./routes/browser-route"
import { configureBrowserViewerOrigins } from "./routes/browser-route"
import { BrowserHostBrokerProcess } from "./host-broker-process"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "scoped-after-assets": new Hono().route("", BrowserRoute()) },
      configureOrigins: configureBrowserViewerOrigins,
      listening: (url) => BrowserHostBrokerProcess.configureServerUrl(url.toString()),
    },
    "browser-runtime",
  )
}
