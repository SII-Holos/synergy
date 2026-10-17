import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "boss",
    async configChanged(change, ctx) {
      const { changedFields, oldConfig, scope: resolvedScope } = change
      const result = change
      if (resolvedScope === "global" && changedFields.includes("boss")) {
        const oldBoss = oldConfig.boss ?? {}
        const newBoss = result.config.boss ?? {}
        if (newBoss.enabled === true && oldBoss.identityText !== newBoss.identityText) {
          try {
            const { BossRuntime } = await import("@ericsanchezok/synergy-boss/boss/boss-runtime")
            await BossRuntime.refreshIdentity({ versioned: true })
          } catch (err) {
            ctx.warnings.push(
              `Failed to refresh runtime boss identity: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (
          newBoss.enabled === true &&
          JSON.stringify(oldBoss.persona ?? null) !== JSON.stringify(newBoss.persona ?? null)
        ) {
          try {
            const { BossRuntime } = await import("@ericsanchezok/synergy-boss/boss/boss-runtime")
            await BossRuntime.refreshIdentity({ versioned: true })
          } catch (err) {
            ctx.warnings.push(
              `Failed to refresh runtime boss persona: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (newBoss.enabled === true && oldBoss.briefingIntervalDays !== newBoss.briefingIntervalDays) {
          try {
            const { BossRuntime } = await import("@ericsanchezok/synergy-boss/boss/boss-runtime")
            await BossRuntime.rescheduleBriefing()
          } catch (err) {
            ctx.warnings.push(
              `Failed to reschedule runtime boss briefing: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
    },
  })
}
