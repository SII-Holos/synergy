import { version } from "../package.json" with { type: "json" }
import { lattice } from "./component"
export const metadata = { id: "lattice", version, apiVersion: 1 }
export function registerWorker() {
  lattice().register()
}
