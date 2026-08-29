import { ScopeStartup } from "../scope/startup"
import { LSP } from "./index"

/**
 * H5 lsp startup contribution: LSP.init moves out of scope/runtime.ts. It
 * runs after format initialization and before the file watcher, matching the
 * historical startup sequence.
 */
export function registerLspStartup() {
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
