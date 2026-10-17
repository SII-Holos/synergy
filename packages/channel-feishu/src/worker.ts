import { version } from "../package.json" with { type: "json" }
import { channelFeishu } from "./component"
export const metadata = { id: "channel-feishu", version, apiVersion: 1 }
export function registerWorker() {
  channelFeishu().register()
}
