import { version } from "../package.json" with { type: "json" }
import { channelClarus } from "./component"
export const metadata = { id: "channel-clarus", version, apiVersion: 1 }
export function registerWorker() {
  channelClarus().register()
}
