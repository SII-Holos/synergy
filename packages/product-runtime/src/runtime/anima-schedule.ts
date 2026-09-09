import { AnimaSchedule as LibraryAnimaSchedule } from "@ericsanchezok/synergy-library/anima-schedule"
import { Agenda } from "@ericsanchezok/synergy-workflows/agenda"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import { AgendaClock } from "@ericsanchezok/synergy-workflows/agenda/clock"
import { AgendaWatcher } from "@ericsanchezok/synergy-workflows/agenda/watcher"
import { AgendaWebhook } from "@ericsanchezok/synergy-workflows/agenda/webhook"
import type { AgendaTypes } from "@ericsanchezok/synergy-workflows/agenda/types"

function item(value: AgendaTypes.Item): LibraryAnimaSchedule.Item {
  return { ...value, scopeID: value.origin.scope.id }
}

export const AnimaSchedule = LibraryAnimaSchedule.create({
  async get(scopeID, id) {
    const value = await AgendaStore.get(scopeID, id).catch(() => undefined)
    return value ? item(value) : undefined
  },
  async list() {
    return (await AgendaStore.listAll()).map(item)
  },
  async create({ id, cron, ...seed }) {
    return item(
      await AgendaStore.create(
        {
          ...seed,
          triggers: [{ type: "cron", ...cron }],
          global: true,
          tags: ["system"],
          createdBy: "user",
        },
        id,
      ),
    )
  },
  async update(value, patch) {
    await AgendaStore.update(value.scopeID, value.id, patch)
  },
  async arm(value) {
    const stored = await AgendaStore.get(value.scopeID, value.id)
    if (stored.state.nextRunAt !== undefined) AgendaClock.rearm(value.scopeID, value.id, stored.state.nextRunAt)
    AgendaWatcher.register(value.id, value.scopeID, stored.triggers)
    AgendaWebhook.register(value.id, value.scopeID, stored.triggers)
  },
  unarm(value) {
    AgendaClock.unload(value.id)
    AgendaWatcher.unregister(value.id)
    AgendaWebhook.unregister(value.id)
  },
  async activate(id) {
    await Agenda.activate(id, { recomputeNextRunAt: true })
  },
  async pause(id) {
    await Agenda.pause(id)
  },
})
