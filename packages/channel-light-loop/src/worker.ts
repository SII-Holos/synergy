import { version } from "../package.json" with { type: "json" }
import { channelLightLoop } from "./component"
export const metadata = { id: "channel-light-loop", version, apiVersion: 1 }
export function registerWorker() {
  channelLightLoop().register()
}
