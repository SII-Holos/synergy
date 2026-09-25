import { registerReload } from "./reload"
import { disposeLibrary } from "./register"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerLibrary } from "./register"

export function library(): RuntimeComponent {
  return {
    id: "library",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    services: () => ({ disposeExtensions: disposeLibrary }),
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url), http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerLibrary()
    },
  }
}
