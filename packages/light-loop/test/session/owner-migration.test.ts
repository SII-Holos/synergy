import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { migrations } from "../../src/session-migration"

test("Light Loop installation upgrades only its retained workflow and terminal records", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const key = ["sessions", "home", "legacy", "info"]
    const unrelated = { planMode: true, future: { lightLoop: true } }
    await Storage.write(key, { lightLoop: { active: true, taskDescription: "keep working" }, unknown: { value: 1 } })
    await Storage.write(["sessions", "home", "plan", "info"], unrelated)
    await migrations[0].up(() => {})
    expect(await Storage.read<unknown>(key)).toEqual({
      workflow: { kind: "lightloop", instructions: "keep working" },
      unknown: { value: 1 },
    })
    expect(await Storage.read<unknown>(["sessions", "home", "plan", "info"])).toEqual(unrelated)
    await Storage.write(key, {
      workflow: { kind: "lightloop", instructions: "keep working", status: "completed" },
      time: { updated: 42 },
      unknown: { value: 1 },
    })
    await migrations[0].up(() => {})
    await migrations[0].up(() => {})
    expect(await Storage.read<unknown>(key)).toEqual({ time: { updated: 42 }, unknown: { value: 1 } })
    expect(await Storage.read<unknown>(["sessions", "home", "legacy", "lightloop_terminal"])).toMatchObject({
      status: "completed",
      createdAt: 42,
    })
  })
})
