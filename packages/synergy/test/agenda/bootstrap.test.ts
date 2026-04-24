import { afterEach, expect, test } from "bun:test"
import { Cron } from "croner"
import fs from "fs/promises"
import path from "path"
import { AgendaBootstrap } from "../../src/agenda/bootstrap"
import { AgendaStore } from "../../src/agenda/store"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Storage } from "../../src/storage/storage"
import { StoragePath } from "../../src/storage/path"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"
import { tmpdir } from "../fixture/fixture"

const originalTestHome = process.env.SYNERGY_TEST_HOME

afterEach(async () => {
  if (originalTestHome === undefined) delete process.env.SYNERGY_TEST_HOME
  else process.env.SYNERGY_TEST_HOME = originalTestHome

  await fs.rm(Global.Path.root, { recursive: true, force: true }).catch(() => {})
})

function withAnima(autonomy: boolean, fn: () => Promise<void>) {
  return async () => {
    await using tmp = await tmpdir()
    process.env.SYNERGY_TEST_HOME = path.join(tmp.path, "home")
    await fs.mkdir(Global.Path.config, { recursive: true })
    await Bun.write(path.join(Global.Path.config, "synergy.jsonc"), JSON.stringify({ identity: { autonomy } }))

    await Instance.provide({
      scope: Scope.global(),
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
  await fs.mkdir(Global.Path.config, { recursive: true })
  await Bun.write(path.join(Global.Path.config, "synergy.jsonc"), JSON.stringify({ identity: { autonomy: true } }))

  await AgendaBootstrap.seed()

  const created = await AgendaStore.get("global", "anima-daily")
  expect(created.id).toBe("anima-daily")
  expect(created.status).toBe("active")
  expect(created.agent).toBe("anima")
})

test(
  "seed does not reactivate a user-paused anima item on startup",
  withAnima(true, async () => {
    await AgendaStore.update("global", "anima-daily", { status: "paused" })

    await AgendaBootstrap.seed()

    const updated = await AgendaStore.get("global", "anima-daily")
    expect(updated.status).toBe("paused")
  }),
)

test(
  "syncAnima reactivates paused items when autonomy is toggled on",
  withAnima(true, async () => {
    await AgendaStore.update("global", "anima-daily", { status: "paused" })

    await AgendaBootstrap.syncAnima(true)

    const updated = await AgendaStore.get("global", "anima-daily")
    expect(updated.status).toBe("active")
  }),
)

test(
  "syncAnima pauses active items when autonomy is toggled off",
  withAnima(true, async () => {
    const before = await AgendaStore.get("global", "anima-daily")
    expect(before.status).toBe("active")

    await AgendaBootstrap.syncAnima(false)

    const updated = await AgendaStore.get("global", "anima-daily")
    expect(updated.status).toBe("paused")
  }),
)

test(
  "syncAnima recomputes next run when re-enabling overdue anima items",
  withAnima(true, async () => {
    const overdueNextRunAt = Date.now() - 60_000

    await AgendaStore.update("global", "anima-daily", { status: "paused" })
    await Storage.update(StoragePath.agendaItem(Identifier.asScopeID("global"), "anima-daily"), (draft: any) => {
      draft.state.nextRunAt = overdueNextRunAt
    })

    await AgendaBootstrap.syncAnima(true)

    const updated = await AgendaStore.get("global", "anima-daily")
    const expectedNextRunAt = new Cron("0 3 * * *", { timezone: "Asia/Shanghai" }).nextRun()?.getTime()

    expect(updated.status).toBe("active")
    expect(updated.state.nextRunAt).toBeDefined()
    expect(updated.state.nextRunAt).toBeGreaterThan(Date.now())
    expect(updated.state.nextRunAt).not.toBe(overdueNextRunAt)
    expect(updated.state.nextRunAt).toBe(expectedNextRunAt)
  }),
)
