import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "library",
    async configChanged(change, ctx) {
      const { changedFields, oldConfig, scope: resolvedScope } = change
      const result = change
      if (resolvedScope === "global" && changedFields.includes("embedding")) {
        const { Embedding } = await import("./vector/embedding")
        await Embedding.dispose()
      }
    },
  })
}
