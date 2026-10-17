import { version } from "../package.json" with { type: "json" }
import { holos } from "./component"
export const metadata = { id: "holos", version, apiVersion: 1 }
export function registerWorker() {
  holos().register()
}
