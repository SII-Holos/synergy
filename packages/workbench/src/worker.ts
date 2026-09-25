import { version } from "../package.json" with { type: "json" }
export const metadata = { id: "workbench", version, apiVersion: 1 }
import { registerConfig } from "./config-schema"

export function registerWorker() {
  registerConfig()
}
