import { version } from "../package.json" with { type: "json" }
export const metadata = { id: "workflows", version, apiVersion: 1 }
import { registerConfig } from "./config-schema"
import { registerSessionSchema } from "./session-schema"

export function registerWorker() {
  registerConfig()
  registerSessionSchema()
}
