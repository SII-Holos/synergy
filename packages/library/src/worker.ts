import { version } from "../package.json" with { type: "json" }
export const metadata = { id: "library", version, apiVersion: 1 }
import { registerConfig } from "./config-schema"

export function registerWorker() {
  registerConfig()
}
