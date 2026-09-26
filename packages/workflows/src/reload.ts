import { RuntimeReloadContributions } from "@ericsanchezok/synergy-harness/config/reload-contributions"
import { Log } from "@ericsanchezok/synergy-harness/util/log"

export function registerReload() {
  RuntimeReloadContributions.register({
    id: "workflows",
    async configChanged(change, ctx) {
      const { changedFields, oldConfig, scope: resolvedScope } = change
      const result = change
      if (changedFields.includes("library")) {
        const oldAutonomy = oldConfig.library?.autonomy !== false
        const newAutonomy = result.config.library?.autonomy !== false
        if (oldAutonomy !== newAutonomy) {
          try {
            const { AnimaSchedule } = await import("./anima-schedule")
            await AnimaSchedule.sync(newAutonomy)
          } catch (err) {
            ctx.warnings.push(
              `Failed to sync anima after library change: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
      }
      if (resolvedScope === "global" && changedFields.includes("boss")) {
        const oldBoss = oldConfig.boss ?? {}
        const newBoss = result.config.boss ?? {}
        if (oldBoss.enabled !== newBoss.enabled) {
          try {
            const { BossRuntime } = await import("./boss/boss-runtime")
            await BossRuntime.sync(newBoss.enabled === true)
          } catch (err) {
            ctx.warnings.push(`Failed to sync runtime boss mode: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        if (newBoss.enabled === true && oldBoss.identityText !== newBoss.identityText) {
          try {
            const { BossRuntime } = await import("./boss/boss-runtime")
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
            const { BossRuntime } = await import("./boss/boss-runtime")
            await BossRuntime.refreshIdentity({ versioned: true })
          } catch (err) {
            ctx.warnings.push(
              `Failed to refresh runtime boss persona: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
        }
        if (newBoss.enabled === true && oldBoss.briefingIntervalDays !== newBoss.briefingIntervalDays) {
          try {
            const { BossRuntime } = await import("./boss/boss-runtime")
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
