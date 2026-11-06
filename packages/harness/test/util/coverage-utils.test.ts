import { describe, expect, test } from "bun:test"
import { Locale } from "../../src/util/locale"
import { compareSemverTuples, parseSemver, satisfiesVersion } from "../../src/util/semver"
import { AsyncQueue, work, workMap } from "../../src/util/queue"
import { Rpc } from "../../src/util/rpc"

describe("Locale formatting", () => {
  test("titlecases each word", () => {
    expect(Locale.titlecase("hello world")).toBe("Hello World")
    expect(Locale.titlecase("synergy cli")).toBe("Synergy Cli")
  })

  test("formats timestamps with time and date styles", () => {
    const input = new Date(2026, 0, 2, 15, 4).getTime()
    expect(Locale.time(input)).toMatch(/\d{1,2}:\d{2}/)
    expect(Locale.datetime(input)).toContain("·")
  })

  test("uses time-only for today and datetime otherwise", () => {
    const now = new Date()
    expect(Locale.todayTimeOrDateTime(now.getTime())).toBe(Locale.time(now.getTime()))
    const past = now.getTime() - 3 * 24 * 3600 * 1000
    expect(Locale.todayTimeOrDateTime(past)).toBe(Locale.datetime(past))
  })

  test("abbreviates numbers by magnitude", () => {
    expect(Locale.number(999)).toBe("999")
    expect(Locale.number(1500)).toBe("1.5K")
    expect(Locale.number(2_500_000)).toBe("2.5M")
  })

  test("formats durations across unit boundaries", () => {
    expect(Locale.duration(500)).toBe("500ms")
    expect(Locale.duration(1500)).toBe("1.5s")
    expect(Locale.duration(90_000)).toBe("1m 30s")
    expect(Locale.duration(5_400_000)).toBe("1h 30m")
    expect(Locale.duration(3 * 86_400_000 + 3_600_000)).toBe("0d 73h")
  })

  test("truncates and truncates from the middle", () => {
    expect(Locale.truncate("short", 10)).toBe("short")
    expect(Locale.truncate("a very long string", 8)).toBe("a very …")
    expect(Locale.truncateMiddle("short", 35)).toBe("short")
    const middle = Locale.truncateMiddle("abcdefghijklmnopqrstuvwxyz", 10)
    expect(middle).toContain("…")
    expect(middle.length).toBeLessThanOrEqual(10)
  })
})

describe("semver", () => {
  test("parses leading triples and rejects junk", () => {
    expect(parseSemver("1.2.3")).toEqual([1, 2, 3])
    expect(parseSemver("1.2.3-beta.1")).toEqual([1, 2, 3])
    expect(parseSemver("v1.2")).toBeNull()
    expect(parseSemver("nope")).toBeNull()
  })

  test("compares tuples lexicographically", () => {
    expect(compareSemverTuples([1, 2, 3], [1, 2, 3])).toBe(0)
    expect(compareSemverTuples([1, 2, 4], [1, 2, 3])).toBeGreaterThan(0)
    expect(compareSemverTuples([2, 0, 0], [10, 0, 0])).toBeLessThan(0)
  })

  test("satisfies >=, ^, ~, x and exact constraints", () => {
    expect(satisfiesVersion("1.2.3", ">=1.0.0")).toBe(true)
    expect(satisfiesVersion("1.2.3", ">=2.0.0")).toBe(false)
    expect(satisfiesVersion("1.2.3", "^1.0.0")).toBe(true)
    expect(satisfiesVersion("2.0.0", "^1.0.0")).toBe(true)
    expect(satisfiesVersion("1.2.3", "^2.0.0")).toBe(false)
    expect(satisfiesVersion("0.2.0", "^0.1.0")).toBe(true)
    expect(satisfiesVersion("0.0.9", "^0.0.8")).toBe(true)
    expect(satisfiesVersion("1.2.3", "~1.2.0")).toBe(true)
    expect(satisfiesVersion("1.1.9", "~1.2.0")).toBe(false)
    expect(satisfiesVersion("1.5.0", "1.x")).toBe(true)
    expect(satisfiesVersion("2.0.0", "1.x")).toBe(false)
    expect(satisfiesVersion("1.2.3", "1.2.3")).toBe(true)
    expect(satisfiesVersion("1.2.4", "1.2.3")).toBe(true)
    expect(satisfiesVersion("1.2.2", "1.2.3")).toBe(false)
    expect(satisfiesVersion("garbage", "^1.0.0")).toBe(false)
    expect(satisfiesVersion("1.0.0", "^garbage")).toBe(false)
    expect(satisfiesVersion("1.0.0", ">=garbage")).toBe(false)
    expect(satisfiesVersion("1.0.0", "~garbage")).toBe(false)
    expect(satisfiesVersion("1.0.0", "garbage")).toBe(false)
    expect(satisfiesVersion("1.2.3", " 1.2.3 ")).toBe(true)
  })
})

describe("AsyncQueue", () => {
  test("delivers pushed items in order to waiting consumers", async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    expect(await queue.next()).toBe(1)
    const pending = queue.next()
    queue.push(3)
    expect(await pending).toBe(2)
    expect(await queue.next()).toBe(3)
  })

  test("iterates over pushed items", async () => {
    const queue = new AsyncQueue<number>()
    const collected: number[] = []
    const iterate = (async () => {
      for await (const item of queue) collected.push(item)
    })()
    queue.push(1)
    queue.push(2)
    await Bun.sleep(10)
    expect(collected).toEqual([1, 2])
    void iterate
  })

  test("resolves waiting consumers before buffering", async () => {
    const queue = new AsyncQueue<string>()
    const first = queue.next()
    queue.push("direct")
    expect(await first).toBe("direct")
    queue.push("buffered")
    expect(await queue.next()).toBe("buffered")
  })
})

describe("work pools", () => {
  test("work processes every item with bounded concurrency", async () => {
    const seen: number[] = []
    const inflight = { current: 0, max: 0 }
    await work(2, [1, 2, 3, 4], async (item) => {
      inflight.current++
      inflight.max = Math.max(inflight.max, inflight.current)
      await Bun.sleep(1)
      seen.push(item)
      inflight.current--
    })
    expect(seen.sort()).toEqual([1, 2, 3, 4])
    expect(inflight.max).toBeLessThanOrEqual(2)
  })

  test("work with zero items completes immediately", async () => {
    await work(3, [], async () => {
      throw new Error("never runs")
    })
  })

  test("workMap preserves result order and limits concurrency", async () => {
    const inflight = { current: 0, max: 0 }
    const results = await workMap(2, [1, 2, 3], async (item) => {
      inflight.current++
      inflight.max = Math.max(inflight.max, inflight.current)
      await Bun.sleep(3 - item)
      inflight.current--
      return item * 10
    })
    expect(results).toEqual([10, 20, 30])
    expect(inflight.max).toBeLessThanOrEqual(2)
  })

  test("workMap with empty items returns empty array", async () => {
    expect(await workMap(2, [], async (x) => x)).toEqual([])
  })
})

describe("Rpc", () => {
  type MessageTarget = {
    postMessage: (data: string) => void | null
    onmessage: ((this: Worker, ev: MessageEvent) => unknown) | null
  }

  function fireMessage(target: MessageTarget, payload: unknown) {
    const handler = target.onmessage as ((ev: MessageEvent) => unknown) | null
    handler?.({ data: JSON.stringify(payload) } as MessageEvent)
  }

  test("client round-trips calls through postMessage and onmessage", async () => {
    const messages: string[] = []
    const target: MessageTarget = {
      postMessage: (data: string) => {
        messages.push(data)
        const parsed = JSON.parse(data)
        queueMicrotask(() => {
          fireMessage(target, { type: "rpc.result", result: 21, id: parsed.id })
        })
      },
      onmessage: null,
    }
    const rpc = Rpc.client<{ add(input: number): number }>(target)
    const result = await rpc.call("add", 21)
    expect(result).toBe(21)
    expect(messages).toHaveLength(1)
    expect(JSON.parse(messages[0])).toMatchObject({ type: "rpc.request", method: "add", input: 21 })
  })

  test("client ignores unrelated messages and unknown result ids", async () => {
    const target: MessageTarget = {
      postMessage: () => {},
      onmessage: null,
    }
    const rpc = Rpc.client<{ ping(): string }>(target)
    const pending = rpc.call("ping", undefined as never)
    fireMessage(target, { type: "other" })
    fireMessage(target, { type: "rpc.result", result: "stale", id: 999 })
    const resolved = { done: false }
    pending.then(() => {
      resolved.done = true
    })
    await Bun.sleep(5)
    expect(resolved.done).toBe(false)
  })
})
