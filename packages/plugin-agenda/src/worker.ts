import { version } from "../package.json" with { type: "json" }
import { pluginAgenda } from "./component"
export const metadata = { id: "plugin-agenda", version, apiVersion: 1 }
export function registerWorker() {
  pluginAgenda().register()
}
