import { expect, test } from "bun:test"
import { RuntimeContext } from "../../src/lifecycle/context"
import { SessionTransferGate } from "../../src/session/transfer-gate"
import { runtimeHome } from "../support/runtime-home"

test("an uncomposed transfer Gate rejects before consulting absent native storage", async () => {
  await using fixture = await runtimeHome()
  const runtime = RuntimeContext.create(fixture.host)
  try {
    await runtime.run(async () => {
      await expect(SessionTransferGate.isFrozen("session")).rejects.toThrow("selected epoch authority")
      await expect(SessionTransferGate.assert("session")).rejects.toThrow("selected epoch authority")
      await expect(SessionTransferGate.assertOwnerMutation("session")).rejects.toThrow("selected epoch authority")
    })
  } finally {
    runtime.dispose()
  }
})
