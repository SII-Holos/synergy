import { LatticeError } from "./lattice/error"
import { Hono } from "hono"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { LatticeRoute } from "./lattice/routes/lattice"
export function registerHttp() {
  Server.registerContributions(
    {
      features: ["lattice"],
      errorStatus: (error) => (error instanceof LatticeError.StateConflict ? 409 : undefined),
      routes: { "scoped-before-assets": new Hono().route("/lattice", LatticeRoute()) },
      isScopeRequiredRoute: (pathname) => pathname === "/lattice" || pathname.startsWith("/lattice/"),
    },
    "lattice",
  )
}
