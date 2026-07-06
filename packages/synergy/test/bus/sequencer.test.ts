import { describe, expect, test } from "bun:test"
import { SyncSequencer } from "../../src/bus/sequencer"

describe("SyncSequencer.stamp", () => {
  test("allocates contiguous increasing seqs and stamps the payload", () => {
    const s = new SyncSequencer("e1")
    const a = { seq: 0 }
    const b = { seq: 0 }
    expect(s.stamp(a, 1)).toBe(1)
    expect(s.stamp(b, 2)).toBe(2)
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    expect(s.current).toBe(2)
  })
})

describe("SyncSequencer.replay", () => {
  test("returns empty when the client is current", () => {
    const s = new SyncSequencer("e1")
    s.stamp({ seq: 0 }, 1)
    const r = s.replay(1, 10)
    expect(r.status).toBe("ok")
    if (r.status === "ok") expect(r.events).toEqual([])
  })

  test("returns the events after sinceSeq", () => {
    const s = new SyncSequencer("e1")
    const p1 = { seq: 0, v: "a" }
    const p2 = { seq: 0, v: "b" }
    const p3 = { seq: 0, v: "c" }
    s.stamp(p1, 1)
    s.stamp(p2, 2)
    s.stamp(p3, 3)
    const r = s.replay(1, 10)
    expect(r.status).toBe("ok")
    if (r.status === "ok") {
      expect(r.events).toEqual([p2, p3])
      expect(r.seq).toBe(3)
      expect(r.epoch).toBe("e1")
    }
  })

  test("resets when the client is ahead of the journal (epoch/impossible)", () => {
    const s = new SyncSequencer("e1")
    s.stamp({ seq: 0 }, 1)
    expect(s.replay(5, 10).status).toBe("reset")
  })

  test("resets when required events have been pruned (client too far behind)", () => {
    const s = new SyncSequencer("e1", 2) // keep at most 2 entries
    s.stamp({ seq: 0 }, 1)
    s.stamp({ seq: 0 }, 2)
    s.stamp({ seq: 0 }, 3) // evicts seq 1; journal now holds 2,3
    // client last saw seq 1; seq 2 is the oldest kept, sinceSeq+1 = 2 == oldest → ok
    expect(s.replay(1, 10).status).toBe("ok")
    // client last saw seq 0; needs seq 1 which is gone → reset
    expect(s.replay(0, 10).status).toBe("reset")
  })

  test("prunes entries older than the age window", () => {
    const s = new SyncSequencer("e1", 4096, 100)
    s.stamp({ seq: 0 }, 0) // seq 1 at t=0
    s.stamp({ seq: 0 }, 50) // seq 2 at t=50
    // at t=1000 both are older than 100ms; a replay from 0 can't be served
    expect(s.replay(0, 1000).status).toBe("reset")
  })

  test("empty journal: current client ok, behind client reset", () => {
    const s = new SyncSequencer("e1")
    expect(s.replay(0, 10).status).toBe("ok") // nothing published, client at 0 is current
    s.stamp({ seq: 0 }, 1)
    s.stamp({ seq: 0 }, 2)
    // force prune everything by age
    const s2 = new SyncSequencer("e1", 4096, 10)
    s2.stamp({ seq: 0 }, 0)
    expect(s2.replay(0, 1000).status).toBe("reset")
  })
})
