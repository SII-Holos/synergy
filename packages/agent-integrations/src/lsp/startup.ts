import { Format } from "../format"
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"
import { LSP } from "."

/**
 * H5 lsp startup contribution: LSP.init moves out of scope/runtime.ts. It
 * runs after format initialization and before the file watcher, matching the
 * historical startup sequence.
 */
export function registerLspStartup() {
  ScopeStartup.register({
    name: "format",
    phase: "surface",
    after: ["resume-pending"],
    before: ["file-watcher"],
    init: () => Format.init(),
  })
  ScopeStartup.register({
    name: "lsp-init",
    phase: "surface",
    after: ["format"],
    before: ["file-watcher"],
    init: async () => {
      await LSP.init()
    },
  })
}
