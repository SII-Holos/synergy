import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { HolosRuntime } from "./holos/runtime"
export function registerReload() {
  RuntimeReloadContributions.register({
    id: "holos",
    targets: {
      async holos() {
        await HolosRuntime.reload()
      },
    },
  })
}
