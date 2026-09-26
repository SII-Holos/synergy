import { createComputerRoute } from "./routes/computer-route"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { Hono } from "hono"

export function registerHttp() {
  Server.registerContributions(
    {
      routes: { "scoped-after-assets": new Hono().route("", createComputerRoute()) },
    },
    "computer-runtime",
  )
}
