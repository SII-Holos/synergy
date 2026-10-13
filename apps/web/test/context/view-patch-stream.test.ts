import { expect, test } from "bun:test"
import { createViewPatchStream } from "../../src/context/view-patch-stream"

test("a delayed snapshot queues deltas, retains unchanged branches and only recovers its own revision gap", async () => {
  const snapshot = Promise.withResolvers<unknown>()
  const emitted: unknown[] = [],
    recovered: string[] = []
  const stream = createViewPatchStream({
    accepts: () => true,
    read: () => snapshot.promise,
    emit: (_scope, value) => emitted.push(value),
    recover: (_scope, value) => recovered.push(value.sessionID),
  })
  const frame = {
    kind: "execution",
    sessionID: "a",
    generation: 1,
    revision: 1,
    previousRevision: 0,
    patches: [],
    snapshot: "snapshot",
  }
  const pending = stream.receive("scope", frame)
  const delta = stream.receive("scope", {
    ...frame,
    snapshot: undefined,
    revision: 2,
    previousRevision: 1,
    patches: [{ path: ["value"], value: 2 }],
  })
  snapshot.resolve({ value: 1, stable: { keep: true } })
  await Promise.all([pending, delta])
  expect(emitted).toEqual([
    { value: 1, stable: { keep: true } },
    { value: 2, stable: { keep: true } },
  ])
  await stream.receive("scope", { ...frame, snapshot: undefined, revision: 4, previousRevision: 3 })
  expect(recovered).toEqual(["a"])
  stream.dispose()
})
test("late checkpoints after unsubscription cannot publish or revive an old owner", async () => {
  const pending = Promise.withResolvers<unknown>()
  let current = true,
    emitted = 0
  const stream = createViewPatchStream({
    accepts: () => current,
    read: () => pending.promise,
    emit: () => emitted++,
    recover() {},
  })
  const request = stream.receive("scope", {
    kind: "execution",
    sessionID: "a",
    generation: 1,
    revision: 1,
    previousRevision: 0,
    patches: [],
    snapshot: "snapshot",
  })
  current = false
  pending.resolve({ value: "old" })
  await request
  expect(emitted).toBe(0)
  stream.dispose()
})
