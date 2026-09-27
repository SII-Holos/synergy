import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerMediaTools } from "./register-tools"
import { registerDocumentExtraction } from "./register-documents"
import { registerMediaAgents } from "./agents"
import { registerConfig } from "./config-schema"

export function media(): RuntimeComponent {
  return {
    id: "media",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerConfig()
      registerMediaTools()
      registerDocumentExtraction()
      registerMediaAgents()
    },
  }
}
