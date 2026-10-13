import type { Part } from "@ericsanchezok/synergy-sdk"
import { expect, test } from "bun:test"
import { createPartProjectionStream } from "../../src/context/part-projection-stream"

test("large checkpoints finish before following appends and stale owners cannot publish", async () => {
  let resolve!: (value: { part: Part; version: string }) => void
  let current = true
  const emitted: Array<{ content?: { kind: string } }> = []
  const stream = createPartProjectionStream({
    accepts: () => current,
    read: () => new Promise((done) => (resolve = done)),
    emit: (_, value) => emitted.push(value),
    recover() {
      throw new Error("unexpected recovery")
    },
  })
  const summary = {
    id: "part",
    messageID: "message",
    sessionID: "session",
    type: "text",
    content: { version: "anchor", bytes: 100000 },
    preview: "large",
  }
  const properties = {
    summary,
    subscription: 1,
    stream: { id: "stream", offset: 100000, revision: 0 },
    content: { kind: "reference" as const, checkpoint: "token" },
  }
  const first = stream.receive("scope", properties)
  const second = stream.receive("scope", {
    ...properties,
    content: { kind: "append", streamID: "stream", offset: 100000, revision: 1, delta: "new" },
  })
  await Promise.resolve()
  expect(emitted).toHaveLength(0)
  resolve({
    part: { id: "part", messageID: "message", sessionID: "session", type: "text", text: "x".repeat(100000) },
    version: "anchor",
  })
  await Promise.all([first, second])
  expect(emitted.map((value) => value.content?.kind)).toEqual(["checkpoint", "append"])
  const late = stream.receive("scope", { ...properties, subscription: 2 })
  await Promise.resolve()
  current = false
  stream.prune()
  resolve({
    part: { id: "part", messageID: "message", sessionID: "session", type: "text", text: "late" },
    version: "anchor",
  })
  await late
  expect(emitted).toHaveLength(2)
  stream.dispose()
})
