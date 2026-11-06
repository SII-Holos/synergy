import { version } from "../package.json" with { type: "json" }
import { email } from "./component"
export const metadata = { id: "email", version, apiVersion: 1 }
export function registerWorker() {
  email().register()
}
