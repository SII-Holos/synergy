import { version } from "../package.json" with { type: "json" }
import { channelLattice } from "./component"
export const metadata = { id: "channel-lattice", version, apiVersion: 1 }
export function registerWorker() {
  channelLattice().register()
}
