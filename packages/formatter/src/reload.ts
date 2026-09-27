import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "formatter",
    targets: {
      async formatter(ctx) {
        const { Format } = await import("@ericsanchezok/synergy-formatter")
        await Format.reload()
        return
      },
    },
  })
}
