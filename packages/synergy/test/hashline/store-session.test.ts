import { afterEach, describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { SessionSnapshotStore } from "../../src/hashline/store-session"
import { ScopeContext } from "../../src/scope/context"
import { SessionEvent } from "../../src/session/event"
import { tmpdir } from "../fixture/fixture"

const originalIdleTtl = process.env.SYNERGY_HASHLINE_SESSION_IDLE_TTL_MS
const originalSessionMax = process.env.SYNERGY_HASHLINE_SESSION_MAX_BYTES

afterEach(() => {
  if (originalIdleTtl === undefined) delete process.env.SYNERGY_HASHLINE_SESSION_IDLE_TTL_MS
  else process.env.SYNERGY_HASHLINE_SESSION_IDLE_TTL_MS = originalIdleTtl
  if (originalSessionMax === undefined) delete process.env.SYNERGY_HASHLINE_SESSION_MAX_BYTES
  else process.env.SYNERGY_HASHLINE_SESSION_MAX_BYTES = originalSessionMax
})

describe("SessionSnapshotStore", () => {
  test("clears retained hashline snapshots after session idle TTL", async () => {
    process.env.SYNERGY_HASHLINE_SESSION_IDLE_TTL_MS = "10"

    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        SessionSnapshotStore.clear()
        const store = SessionSnapshotStore.get("ses_hashline_idle")
        store.record("/tmp/a.ts", "x".repeat(1024))

        expect(SessionSnapshotStore.stats().sessions).toBe(1)
        expect(SessionSnapshotStore.stats().totalBytes).toBe(1024)

        await Bus.publish(SessionEvent.Idle, { sessionID: "ses_hashline_idle" })
        await new Promise((resolve) => setTimeout(resolve, 50))

        expect(SessionSnapshotStore.stats().sessions).toBe(0)
        expect(SessionSnapshotStore.stats().totalBytes).toBe(0)
      },
    })
  })
})
