import { VoiceRoute } from "./voice/routes/voice-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"
import { RenderRoute } from "./render/routes"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "scoped-after-assets": new Hono().route("/voice", VoiceRoute()).route("/render", RenderRoute()) },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/voice", "/render"]),
    },
    "media",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
