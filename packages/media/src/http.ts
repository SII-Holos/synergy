import { VoiceRoute } from "./voice/routes/voice-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "scoped-after-assets": new Hono().route("/voice", VoiceRoute()) },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/voice"]),
    },
    "media",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
