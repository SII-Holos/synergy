import { describe, expect, test } from "bun:test"
import { planBucketEviction } from "../../src/context/message-eviction"

const S = (...ids: string[]) => new Set(ids)

describe("planBucketEviction", () => {
  test("evicts nothing when at or under the cap", () => {
    expect(planBucketEviction(["a", "b", "c"], 3, S())).toEqual([])
    expect(planBucketEviction([], 3, S())).toEqual([])
  })

  test("evicts the oldest beyond the cap", () => {
    // 5 loaded, cap 3, no protection → evict oldest 2
    expect(planBucketEviction(["a", "b", "c", "d", "e"], 3, S())).toEqual(["a", "b"])
  })

  test("never evicts a protected id even when it is the oldest (active session)", () => {
    // "a" is the active session but oldest in LRU; it must survive.
    const evicted = planBucketEviction(["a", "b", "c", "d", "e"], 3, S("a"))
    expect(evicted).not.toContain("a")
    // budget = cap(3) - protected(1) = 2 kept among b..e → evict oldest of them: b, c
    expect(evicted).toEqual(["b", "c"])
  })

  test("protected set counts against the cap budget", () => {
    const evicted = planBucketEviction(["a", "b", "c", "d"], 2, S("d"))
    // protected d; budget = 2-1 = 1 (keep newest non-protected = c); evict a,b
    expect(evicted).toEqual(["a", "b"])
  })

  test("all protected keeps everything", () => {
    expect(planBucketEviction(["a", "b"], 1, S("a", "b"))).toEqual([])
  })
})
