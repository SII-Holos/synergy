import { version } from "../package.json" with { type: "json" }
import { boss } from "./component"
export const metadata = { id: "boss", version, apiVersion: 1 }
export function registerWorker() {
  boss().register()
}
