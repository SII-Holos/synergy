import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerNote } from "./register"

export function note(): RuntimeComponent {
  return {
    id: "note",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    adapters: { http: new URL("./http.ts", import.meta.url) },
    register() {
      registerNote()
    },
  }
}
