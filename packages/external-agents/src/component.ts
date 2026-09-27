import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerExternalAgentSessionBridge } from "./session-bridge"
import { registerAgentExternalSource } from "./agent-source"
import { registerConfig } from "./config-schema"

export function externalAgents(): RuntimeComponent {
  return {
    id: "external-agents",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    register() {
      registerConfig()
      registerExternalAgentSessionBridge()
      registerAgentExternalSource()
    },
  }
}
