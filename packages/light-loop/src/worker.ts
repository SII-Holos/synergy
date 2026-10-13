import { version } from "../package.json" with { type: "json" }
import { lightLoop } from "./component"
export const metadata = { id: "light-loop", version, apiVersion: 1 }
export function registerWorker() {
  lightLoop().register()
}
