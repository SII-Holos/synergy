import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "lsp",
    targets: {
      async lsp(ctx) {
        const { LSP } = await import("@ericsanchezok/synergy-lsp")
        await LSP.reload()
        return
      },
    },
  })
}
