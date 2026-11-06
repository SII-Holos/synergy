import { describe, expect, test } from "bun:test"
import { publishCompareKey, decideSessionPublish } from "../../src/session/publish-dedup"

describe("publishCompareKey", () => {
  test("infos differing only in time.updated produce the same key", () => {
    const a = { id: "s", title: "T", time: { created: 1, updated: 100 } }
    const b = { id: "s", title: "T", time: { created: 1, updated: 200 } }
    expect(publishCompareKey(a)).toBe(publishCompareKey(b))
  })

  test("a real field change produces a different key", () => {
    const a = { id: "s", title: "T", time: { created: 1, updated: 100 } }
    const b = { id: "s", title: "T2", time: { created: 1, updated: 100 } }
    expect(publishCompareKey(a)).not.toBe(publishCompareKey(b))
  })

  test("a nested field change produces a different key", () => {
    const a = { id: "s", blueprint: { node: 1 }, time: { created: 1, updated: 100 } }
    const b = { id: "s", blueprint: { node: 2 }, time: { created: 1, updated: 100 } }
    expect(publishCompareKey(a)).not.toBe(publishCompareKey(b))
  })

  test("does not mutate the input", () => {
    const a = { id: "s", time: { created: 1, updated: 100 } }
    publishCompareKey(a)
    expect(a.time.updated).toBe(100)
  })

  test("time.created is still significant", () => {
    const a = { id: "s", time: { created: 1, updated: 100 } }
    const b = { id: "s", time: { created: 2, updated: 100 } }
    expect(publishCompareKey(a)).not.toBe(publishCompareKey(b))
  })
})

describe("decideSessionPublish", () => {
  const throttleMs = 1000

  test("publishes when there is no prior publish", () => {
    expect(decideSessionPublish({ prevKey: undefined, prevAt: undefined, nextKey: "k", now: 0, throttleMs })).toBe(true)
  })

  test("publishes immediately on a meaningful change", () => {
    expect(decideSessionPublish({ prevKey: "a", prevAt: 0, nextKey: "b", now: 10, throttleMs })).toBe(true)
  })

  test("skips an unchanged payload within the throttle window", () => {
    expect(decideSessionPublish({ prevKey: "a", prevAt: 0, nextKey: "a", now: 500, throttleMs })).toBe(false)
  })

  test("republishes an unchanged payload once the throttle window elapses", () => {
    expect(decideSessionPublish({ prevKey: "a", prevAt: 0, nextKey: "a", now: 1000, throttleMs })).toBe(true)
    expect(decideSessionPublish({ prevKey: "a", prevAt: 0, nextKey: "a", now: 1500, throttleMs })).toBe(true)
  })

  test("#319: repeated time.updated-only writes collapse to a heartbeat", () => {
    // Simulate a blueprint loop bumping time.updated many times in <1s.
    const base = { id: "s", title: "Blueprint", time: { created: 1, updated: 0 } }
    let prev: { key: string; at: number } | undefined
    let published = 0
    for (let i = 0; i < 20; i++) {
      const info = { ...base, time: { created: 1, updated: i * 40 } } // 20 updates over ~760ms
      const key = publishCompareKey(info)
      const now = i * 40
      if (decideSessionPublish({ prevKey: prev?.key, prevAt: prev?.at, nextKey: key, now, throttleMs })) {
        prev = { key, at: now }
        published++
      }
    }
    expect(published).toBe(1) // only the very first; the rest are deduped
  })

  test("a real change amid time-only churn still publishes", () => {
    const throttle = 1000
    let prev: { key: string; at: number } | undefined
    const emit = (info: Record<string, unknown>, now: number) => {
      const key = publishCompareKey(info)
      const ok = decideSessionPublish({ prevKey: prev?.key, prevAt: prev?.at, nextKey: key, now, throttleMs: throttle })
      if (ok) prev = { key, at: now }
      return ok
    }
    expect(emit({ id: "s", title: "A", time: { created: 1, updated: 0 } }, 0)).toBe(true)
    expect(emit({ id: "s", title: "A", time: { created: 1, updated: 100 } }, 100)).toBe(false) // time-only
    expect(emit({ id: "s", title: "B", time: { created: 1, updated: 150 } }, 150)).toBe(true) // real change
  })
})
