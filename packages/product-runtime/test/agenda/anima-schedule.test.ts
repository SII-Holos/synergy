import { afterEach, expect, test } from "bun:test"
import { Cron } from "croner"
import fs from "fs/promises"
import path from "path"
import { AnimaSchedule } from "../../src/runtime/anima-schedule"
import { AgendaStore } from "@ericsanchezok/synergy-workflows/agenda/store"
import { Global } from "@ericsanchezok/synergy-harness/global"
import { Identifier } from "@ericsanchezok/synergy-harness/id/id"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { StoragePath } from "@ericsanchezok/synergy-harness/storage/path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

const originalTestHome = process.env.SYNERGY_TEST_HOME

afterEach(async () => {
  const currentHome = process.env.SYNERGY_TEST_HOME
  const rootToClean = currentHome !== originalTestHome ? Global.Path.root : undefined

  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome

  if (rootToClean) await fs.rm(rootToClean, { recursive: true, force: true }).catch(() => {})
})

function withAnima(autonomy: boolean, fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()
    process.env.SYNERGY_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(Global.Path.config, { recursive: true })
    await Bun.write(path.join(Global.Path.config, "synergy.jsonc"), JSON.stringify({ library: { autonomy } }))

    await ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        await AgendaStore.create(
          {
            title: "Anima daily wake",
            prompt: "你醒了。",
            triggers: [{ type: "cron", expr: "0 3 * * *", tz: "Asia/Shanghai" }],
            agent: "anima",
            silent: true,
            wake: false,
            global: true,
            tags: ["system"],
            createdBy: "user",
          },
          "anima-daily",
        )
        await fn()
      },
    })
  }
}

test("seed creates anima item on startup when missing", async () => {
  await using tmp = await tmpdir()
  process.env.SYNERGY_TEST_HOME = path.join(tmp.path, "home")
  await Bun.write(path.join(Global.Path.config, "synergy.jsonc"), JSON.stringify({ library: { autonomy: true } }))

  await AnimaSchedule.seed()

  const created = await AgendaStore.get("home", "anima-daily")
  expect(created.id).toBe("anima-daily")
  expect(created.status).toBe("active")
  expect(created.agent).toBe("anima")
})

test(
  "seed does not reactivate a user-paused anima item on startup",
  withAnima(true, async () => {
    await AgendaStore.update("home", "anima-daily", { status: "paused" })

    await AnimaSchedule.seed()

    const updated = await AgendaStore.get("home", "anima-daily")
    expect(updated.status).toBe("paused")
  }),
)

test(
  "syncAnima reactivates paused items when autonomy is toggled on",
  withAnima(true, async () => {
    await AgendaStore.update("home", "anima-daily", { status: "paused" })

    await AnimaSchedule.sync(true)

    const updated = await AgendaStore.get("home", "anima-daily")
    expect(updated.status).toBe("active")
  }),
)

test(
  "syncAnima pauses active items when autonomy is toggled off",
  withAnima(true, async () => {
    const before = await AgendaStore.get("home", "anima-daily")
    expect(before.status).toBe("active")

    await AnimaSchedule.sync(false)

    const updated = await AgendaStore.get("home", "anima-daily")
    expect(updated.status).toBe("paused")
  }),
)

test(
  "syncAnima recomputes next run when re-enabling overdue anima items",
  withAnima(true, async () => {
    const overdueNextRunAt = Date.now() - 60_000

    await AgendaStore.update("home", "anima-daily", { status: "paused" })
    await Storage.update(StoragePath.agendaItem(Identifier.asScopeID("home"), "anima-daily"), (draft: any) => {
      draft.state.nextRunAt = overdueNextRunAt
    })

    await AnimaSchedule.sync(true)

    const updated = await AgendaStore.get("home", "anima-daily")
    const expectedNextRunAt = new Cron("0 3 * * *", { timezone: "Asia/Shanghai" }).nextRun()?.getTime()

    expect(updated.status).toBe("active")
    expect(updated.state.nextRunAt).toBeDefined()
    expect(updated.state.nextRunAt).toBeGreaterThan(Date.now())
    expect(updated.state.nextRunAt).not.toBe(overdueNextRunAt)
    expect(updated.state.nextRunAt).toBe(expectedNextRunAt)
  }),
)
