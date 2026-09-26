import { NoteRoute } from "./routes/note"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "scoped-before-assets": new Hono().route("/note", NoteRoute()) },
      isScopeRequiredRoute: (pathname) => matchesPath(pathname, ["/note"]),
    },
    "note",
  )
}

function matchesPath(pathname: string, prefixes: string[]) {
  return prefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
}
