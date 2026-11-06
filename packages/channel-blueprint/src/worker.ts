import { version } from "../package.json" with { type: "json" }
import { channelBlueprint } from "./component"
export const metadata = { id: "channel-blueprint", version, apiVersion: 1 }
export function registerWorker() {
  channelBlueprint().register()
}
