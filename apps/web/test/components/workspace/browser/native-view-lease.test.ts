import { expect, test } from "bun:test"
import { claimNativeView } from "../../../../src/components/workspace/browser/native-view-lease"

test("late native attachment and disposal cannot detach a successor presentation", async () => {
  const bridge = {}
  const calls: string[] = []
  const gate = Promise.withResolvers<void>()
  const a = claimNativeView(bridge, "page")
  const attaching = a.run(async () => {
    calls.push("attach A")
    await gate.promise
  })
  await Promise.resolve()
  const released = a.release(() => {
    calls.push("detach A")
  })
  const b = claimNativeView(bridge, "page")
  const attached = b.run(() => {
    calls.push("attach B")
  })
  gate.resolve()
  await Promise.all([attaching, released, attached])
  expect(calls).toEqual(["attach A", "attach B"])
  await b.release(() => {
    calls.push("detach B")
  })
  expect(calls).toEqual(["attach A", "attach B", "detach B"])
  await a.run(() => {
    throw new Error("inactive presentation ran")
  })
})
