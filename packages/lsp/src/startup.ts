import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { LSP } from "."

export function registerLspStartup() {
  ScopeStartup.register({
    name: "lsp-init",
    owner: "workspace",
    phase: "surface",
    after: ["session-pause-reconcile"],
    before: ["file-watcher"],
    init: async () => {
      await LSP.init()
    },
  })
}
