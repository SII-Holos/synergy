import { expect, spyOn, test } from "bun:test"
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

test("terminal extraction rolls back with its Session metadata and can be retried", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const owner = { scopeID: "home", sessionID: "interrupted" }
    const key = ["sessions", owner.scopeID, owner.sessionID, "info"]
    const terminalKey = ["sessions", owner.scopeID, owner.sessionID, "lightloop_terminal"]
    const value = {
      workflow: { kind: "lightloop", instructions: "retained", status: "completed", terminalHookDeliveredAt: 12 },
      time: { updated: 42 },
      unknown: { retained: true },
    }
    await Storage.write(key, value)
    const write = Storage.write
    {
      using failure = spyOn(Storage, "write").mockImplementation(async (target, next) => {
        if (target.join("/") === key.join("/")) throw new Error("interrupted metadata publication")
        return write(target, next)
      })
      await expect(migrations[0].upSession!(owner, () => {})).rejects.toThrow("interrupted metadata publication")
    }
    expect(await Storage.read<unknown>(key)).toEqual(value)
    expect(await Storage.readMany([terminalKey])).toEqual([undefined])
    await migrations[0].upSession!(owner, () => {})
    const terminal = await Storage.read<unknown>(terminalKey)
    expect(terminal).toMatchObject({ status: "completed", hookDeliveredAt: 12, createdAt: 42 })
    expect(await Storage.read<unknown>(key)).toEqual({ time: { updated: 42 }, unknown: { retained: true } })
    await migrations[0].upSession!(owner, () => {})
    expect(await Storage.read<unknown>(terminalKey)).toEqual(terminal)
  })
})
