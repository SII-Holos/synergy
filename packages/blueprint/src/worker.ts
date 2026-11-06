import { version } from "../package.json" with { type: "json" }
import { blueprint } from "./component"
export const metadata = { id: "blueprint", version, apiVersion: 1 }
export function registerWorker() {
  blueprint().register()
}
