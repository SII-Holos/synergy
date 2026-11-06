/**
 * Pins the session-chain replay fast-path against an anchor-content
 * corruption window.
 */
import { describe, expect, test } from "bun:test"
import { InMemorySnapshotStore, parsePatch, RECOVERY_SESSION_REPLAY_WARNING, Recovery } from "../../src/hashline/index"

const PATH = "/tmp/__hashline-recovery-session-chain__.ts"

function makeContent(prefix: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${prefix}${i + 1}`).join("\n") + "\n"
}

describe("Recovery — session-chain replay anchor-content gate", () => {
  test("refuses replay when an edit anchor's line content diverges between snapshot and current", () => {
    const store = new InMemorySnapshotStore()
    const recovery = new Recovery(store)

    const v0 = makeContent("L", 5)
    const tag0 = store.record(PATH, v0)
    const v1 = v0.replace("L3\n", "L3-CHANGED\n")

    const { edits } = parsePatch(`SWAP 3.=3:\n+L3-MODEL\n`)
    const result = recovery.tryRecover({ path: PATH, currentText: v1, fileHash: tag0, edits })
    expect(result).toBeNull()
  })

  test("replays edits onto current when every anchor's line content is unchanged", () => {
    const store = new InMemorySnapshotStore()
    const recovery = new Recovery(store)

    const v0 = makeContent("L", 10)
    const tag0 = store.record(PATH, v0)
    const v1 = v0.replace("L5\n", "L5-CHANGED\n")
    store.record(PATH, v1) // prior in-session edit advances the hash

    const { edits } = parsePatch(`SWAP 3.=3:\n+L3-MODEL\n`)
    const result = recovery.tryRecover({ path: PATH, currentText: v1, fileHash: tag0, edits })
    expect(result).not.toBeNull()
    if (result) {
      expect(result.text).toContain("L3-MODEL")
      expect(result.text).toContain("L5-CHANGED")
      expect(result.warnings).toContain(RECOVERY_SESSION_REPLAY_WARNING)
    }
  })

  test("session-chain replay surfaces the replay warning banner", () => {
    const store = new InMemorySnapshotStore()
    const recovery = new Recovery(store)

    const v0 = makeContent("L", 4)
    const tag0 = store.record(PATH, v0)
    const v1 = "L1\nL2\nL3\nL4\n"
    store.record(PATH, v1)

    const { edits } = parsePatch(`INS.TAIL:\n+L5\n`)
    const result = recovery.tryRecover({ path: PATH, currentText: v1, fileHash: tag0, edits })
    expect(result).not.toBeNull()
    if (result) {
      expect(result.text).toBe("L1\nL2\nL3\nL4\nL5\n")
      expect(result.warnings.length).toBeGreaterThan(0)
    }
  })

  test("3-way merge is preferred over session-chain replay when patch context matches", () => {
    const store = new InMemorySnapshotStore()
    const recovery = new Recovery(store)

    const v0 = makeContent("L", 5)
    const tag0 = store.record(PATH, v0)
    const v1 = v0 + "L6\n"

    const { edits } = parsePatch(`SWAP 3.=3:\n+L3-MODEL\n`)
    const result = recovery.tryRecover({ path: PATH, currentText: v1, fileHash: tag0, edits })
    expect(result).not.toBeNull()
    if (result) {
      expect(result.text).toContain("L3-MODEL")
      expect(result.text).toContain("L6")
    }
  })
})
