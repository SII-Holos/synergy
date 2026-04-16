import { AgendaClock } from "./clock"
import { AgendaStore } from "./store"
import { AgendaWatcher } from "./watcher"
import { AgendaWebhook } from "./webhook"
import { Instance } from "../scope/instance"
import { Scope } from "../scope"
import { Log } from "../util/log"

const SEED_ID = "anima-daily"

export namespace AgendaBootstrap {
  const log = Log.create({ service: "agenda.bootstrap" })

  async function isAutonomyEnabled(): Promise<boolean> {
    const { Config } = await import("../config/config")
    const config = await Config.get()
    return config.identity?.autonomy !== false
  }

  export async function seed(): Promise<void> {
    const scopeID = "global"

    await Instance.provide({
      scope: Scope.global(),
      fn: async () => {
        const existing = await AgendaStore.get(scopeID, SEED_ID).catch(() => undefined)
        const enabled = await isAutonomyEnabled()

        if (existing) {
          // On startup, only enforce the "disable" direction: if autonomy is off,
          // ensure active anima items are paused. Never re-activate paused items —
          // that would override an explicit user pause. Re-activation only happens
          // when the user explicitly toggles autonomy on (handled by syncAnima via
          // the config change handler).
          if (!enabled) await enforceAnimaDisabled()
          return
        }

        const item = await AgendaStore.create(
          {
            title: "Anima daily wake",
            triggers: [{ type: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" }],
            task: {
              prompt: "你醒了。",
              agent: "anima",
            },
            delivery: { target: "silent" },
            tags: ["system"],
            createdBy: "user",
          },
          SEED_ID,
        )

        if (!enabled) {
          await AgendaStore.update(scopeID, item.id, { status: "paused" })
          log.info("anima seed created (paused — autonomy disabled)", { id: item.id })
          return
        }

        if (item.state.nextRunAt !== undefined) {
          AgendaClock.rearm(scopeID, item.id, item.state.nextRunAt)
        }
        AgendaWatcher.register(item.id, scopeID, item.triggers)
        AgendaWebhook.register(item.id, scopeID, item.triggers)
        log.info("anima seed created", { id: item.id, nextRunAt: item.state.nextRunAt })
      },
    })
  }

  /**
   * Bidirectional sync: activate or pause anima items to match the autonomy setting.
   * Called when the user explicitly toggles autonomy at runtime (via config change handler).
   */
  export async function syncAnima(enabled: boolean): Promise<void> {
    const items = await AgendaStore.listAll()
    const animaItems = items.filter((item) => item.task?.agent === "anima")
    if (animaItems.length === 0) return

    const { Agenda } = await import("./index")
    for (const item of animaItems) {
      if (enabled && item.status === "paused") {
        await Agenda.activate(item.id, { recomputeNextRunAt: true })
        log.info("anima item activated", { id: item.id, title: item.title })
      } else if (!enabled && item.status === "active") {
        await Agenda.pause(item.id)
        log.info("anima item paused", { id: item.id, title: item.title })
      }
    }
  }

  async function enforceAnimaDisabled(): Promise<void> {
    const items = await AgendaStore.listAll()
    for (const item of items) {
      if (item.task?.agent === "anima" && item.status === "active") {
        await AgendaStore.update(item.origin.scope.id, item.id, { status: "paused" })
        AgendaClock.unload(item.id)
        AgendaWatcher.unregister(item.id)
        AgendaWebhook.unregister(item.id)
        log.info("anima item paused (autonomy disabled on startup)", { id: item.id, title: item.title })
      }
    }
  }
}
