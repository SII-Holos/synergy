import { disposeBrowser } from "./register"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerBrowser } from "./register"

export function browser(): RuntimeComponent {
  return {
    id: "browser-runtime",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    services: () => ({ disposeExtensions: disposeBrowser }),
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url), http: new URL("./http.ts", import.meta.url) },
    register() {
      registerBrowser()
    },
  }
}
