import { expect, test } from "bun:test"
import { createMessageArrivalState } from "../../src/context/message-arrival"

test("a submitted message enters once, including an unrendered canonical handoff", () => {
  let now = 0
  const arrivals = createMessageArrivalState(() => now)
  const key = ["server", "scope", "session"] as const
  expect(arrivals.take(key, "history")).toBe(false)
  arrivals.add(key, "optimistic")
  arrivals.handoff(key, "optimistic", "canonical")
  expect(arrivals.take(key, "optimistic")).toBe(false)
  expect(arrivals.take(key, "canonical")).toBe(true)
  expect(arrivals.take(key, "canonical")).toBe(false)

  arrivals.add(key, "rendered")
  expect(arrivals.take(key, "rendered")).toBe(true)
  arrivals.handoff(key, "rendered", "accepted")
  expect(arrivals.take(key, "accepted")).toBe(false)
  arrivals.add(key, "background")
  now = 3000
  expect(arrivals.take(key, "background")).toBe(false)
})

test("arrival ownership excludes other servers, Scopes, Sessions and removed submissions", () => {
  const arrivals = createMessageArrivalState()
  const key = ["server", "scope", "session"] as const
  arrivals.add(key, "message")
  for (let index = 0; index < key.length; index++) {
    const other: string[] = [...key]
    other[index] = "other"
    expect(arrivals.take(other, "message")).toBe(false)
  }
  arrivals.remove(key, "message")
  expect(arrivals.take(key, "message")).toBe(false)
})
