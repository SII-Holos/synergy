import { version } from "../package.json" with { type: "json" }
import { bossFeishu } from "./component"
export const metadata = { id: "boss-feishu", version, apiVersion: 1 }
export function registerWorker() {
  bossFeishu().register()
}
