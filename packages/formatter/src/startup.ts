import { Format } from "."
import { ScopeStartup } from "@ericsanchezok/synergy-harness/scope/startup"

export function registerFormatterStartup() {
  ScopeStartup.register({
    name: "format",
    owner: "workspace",
    phase: "surface",
    after: ["session-pause-reconcile"],
    before: ["file-watcher"],
    init: () => Format.init(),
  })
}
