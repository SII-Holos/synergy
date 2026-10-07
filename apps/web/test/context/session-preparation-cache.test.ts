import { expect, test } from "bun:test"
import type { StorageSessionPreparation } from "@ericsanchezok/synergy-sdk/client"
import { createSessionPreparationCache } from "../../src/context/session-preparation-cache"

const preparation = (sessionID: string, state: StorageSessionPreparation["state"] = "ready") =>
  ({ sessionID, state }) as StorageSessionPreparation

test("retains ready sessions by server in bounded access order and clears on runtime loss", () => {
  const cache = createSessionPreparationCache(2)
  cache.set("one", preparation("a"))
  cache.set("two", preparation("a"))
  expect(cache.get("three", "a")).toBeUndefined()
  expect(cache.get("one", "a")?.state).toBe("ready")
  cache.set("one", preparation("b"))
  expect(cache.get("two", "a")).toBeUndefined()
  expect(cache.get("one", "a")?.state).toBe("ready")
  cache.set("one", preparation("a", "pending"))
  expect(cache.get("one", "a")).toBeUndefined()
  cache.clear()
  expect(cache.get("one", "b")).toBeUndefined()
})
