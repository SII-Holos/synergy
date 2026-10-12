import { version } from "../package.json" with { type: "json" }
import { github } from "./component"
export const metadata = { id: "github", version, apiVersion: 1 }
export function registerWorker() {
  github().register()
}
