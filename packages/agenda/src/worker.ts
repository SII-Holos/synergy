import { version } from "../package.json" with { type: "json" }
import { agenda } from "./component"
export const metadata = { id: "agenda", version, apiVersion: 1 }
export function registerWorker() {
  agenda().register()
}
