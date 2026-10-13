import { version } from "../package.json" with { type: "json" }
import { channels } from "./component"
export const metadata = { id: "channels", version, apiVersion: 1 }
export function registerWorker() {
  channels().register()
}
