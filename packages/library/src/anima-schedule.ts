import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Log } from "@ericsanchezok/synergy-harness/util/log"
import { readConfig } from "./config-schema"

export namespace AnimaSchedule {
  export interface Item {
    id: string
    title: string
    agent?: string
    status: string
    scopeID: string
    sessionMode?: string
  }

  export interface Seed {
    id: string
    title: string
    prompt: string
    cron: { expr: string; tz: string }
    agent: string
    sessionMode: "ephemeral"
    silent: boolean
    wake: boolean
  }

  export interface Agenda {
    get(scopeID: string, id: string): Promise<Item | undefined>
    list(): Promise<Item[]>
    create(seed: Seed): Promise<Item>
    update(item: Item, patch: { status?: "paused"; sessionMode?: "ephemeral" }): Promise<void>
    arm(item: Item): Promise<void>
    unarm(item: Item): void
    activate(id: string): Promise<void>
    pause(id: string): Promise<void>
  }

  export function create(agenda: Agenda) {
    const log = Log.create({ service: "library.anima-schedule" })
    const seedID = "anima-daily"

    async function enforceDisabled() {
      for (const item of await agenda.list()) {
        if (item.agent !== "anima" || item.status !== "active") continue
        await agenda.update(item, { status: "paused" })
        agenda.unarm(item)
        log.info("anima item paused (autonomy disabled on startup)", { id: item.id, title: item.title })
      }
    }

    async function seed() {
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const existing = await agenda.get("home", seedID)
          const enabled = (await readConfig()).library?.autonomy !== false
          if (existing) {
            if (!enabled) await enforceDisabled()
            if (!existing.sessionMode) await agenda.update(existing, { sessionMode: "ephemeral" })
            return
          }
          const item = await agenda.create({
            id: seedID,
            title: "Anima daily wake",
            prompt: "你醒了。",
            cron: { expr: "0 3 * * *", tz: "Asia/Shanghai" },
            agent: "anima",
            sessionMode: "ephemeral",
            silent: true,
            wake: false,
          })
          if (!enabled) {
            await agenda.update(item, { status: "paused" })
            log.info("anima seed created (paused — autonomy disabled)", { id: item.id })
            return
          }
          await agenda.arm(item)
          log.info("anima seed created", { id: item.id })
        },
      })
    }

    async function sync(enabled: boolean) {
      for (const item of await agenda.list()) {
        if (item.agent !== "anima") continue
        if (enabled && item.status === "paused") {
          await agenda.activate(item.id)
          log.info("anima item activated", { id: item.id, title: item.title })
        } else if (!enabled && item.status === "active") {
          await agenda.pause(item.id)
          log.info("anima item paused", { id: item.id, title: item.title })
        }
      }
    }

    return { seed, sync }
  }
}
