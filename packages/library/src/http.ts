import { LibraryRoute } from "./routes/library"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      features: ["library"],
      routes: { "scoped-before-assets": new Hono().route("/library", LibraryRoute()) },
    },
    "library",
  )
}
