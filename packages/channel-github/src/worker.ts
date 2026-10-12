import { version } from "../package.json" with { type: "json" }
import { channelGithub } from "./component"
export const metadata = { id: "channel-github", version, apiVersion: 1 }
export function registerWorker() {
  channelGithub().register()
}
