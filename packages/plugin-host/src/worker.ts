import { version } from "../package.json" with { type: "json" }
import { plugins } from "./component"
export const metadata = { id: "plugin-host", version, apiVersion: 1 }
export function registerWorker() {
  plugins().register()
}
