import { registerReload } from "./reload"
import type { RuntimeComponent } from "@ericsanchezok/synergy-harness/lifecycle"
import { version } from "../package.json" with { type: "json" }
import { registerLspTools } from "./tools"
import { registerLspStartup } from "./startup"
import { registerLspSessionInput } from "./session-input"
import { registerLspToolSource } from "./tool-source"
import { registerWorkspaceFileSymbolSource } from "./workspace-symbol-source"
import { registerLspConfigCatalog } from "./config-catalog"
import { registerConfig } from "./config-schema"

export function lsp(): RuntimeComponent {
  return {
    id: "lsp",
    apiVersion: 1,
    version,
    requires: { "local-runtime": version },
    after: ["formatter"],
    workers: { agent: new URL("./worker.ts", import.meta.url) },
    adapters: { cli: new URL("./cli-adapter.ts", import.meta.url), http: new URL("./http.ts", import.meta.url) },
    register() {
      registerReload()
      registerConfig()
      registerLspTools()
      registerLspStartup()
      registerLspSessionInput()
      registerLspToolSource()
      registerWorkspaceFileSymbolSource()
      registerLspConfigCatalog()
    },
  }
}
