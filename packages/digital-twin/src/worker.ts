import { version } from "../package.json" with { type: "json" }
import { registerAgents } from "./agents"
import { registerConfig } from "./config-schema"
export const metadata = { id: "digital-twin", version, apiVersion: 1 }
export function registerWorker() {
  registerConfig()
  registerAgents()
}
