import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { AnimaSchedule } from "./anima-schedule"
export function registerReload() {
  RuntimeReloadContributions.register({
    id: "anima",
    async configChanged(change) {
      if (
        change.changedFields.includes("anima") &&
        (change.oldConfig.anima?.enabled !== false) !== (change.config.anima?.enabled !== false)
      )
        await AnimaSchedule.sync(change.config.anima?.enabled !== false)
    },
  })
}
