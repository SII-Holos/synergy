import { version } from "../package.json" with { type: "json" }
import { anima } from "./component"
export const metadata = { id: "anima", version, apiVersion: 1 }
export function registerWorker() {
  anima().register()
}
