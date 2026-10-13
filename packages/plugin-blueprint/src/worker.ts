import { version } from "../package.json" with { type: "json" }
import { pluginBlueprint } from "./component"
export const metadata = { id: "plugin-blueprint", version, apiVersion: 1 }
export function registerWorker() {
  pluginBlueprint().register()
}
