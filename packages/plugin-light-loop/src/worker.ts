import { version } from "../package.json" with { type: "json" }
import { pluginLightLoop } from "./component"
export const metadata = { id: "plugin-light-loop", version, apiVersion: 1 }
export function registerWorker() {
  pluginLightLoop().register()
}
