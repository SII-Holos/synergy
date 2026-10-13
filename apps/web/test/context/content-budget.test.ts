import { expect, test } from "bun:test"
import { createContentBudget } from "../../src/context/content-budget"

test("content pressure retires presentation snapshots before evicting their materialized bodies", () => {
  const budget = createContentBudget(16)
  const order: string[] = []
  const release = budget.retain("inactive")
  budget.publish("inactive", "one", 12, () => order.push("body"))
  const off = budget.onPressure(() => {
    order.push("view")
    release()
  })
  budget.publish("active", "one", 12, () => order.push("active"))
  expect(order).toEqual(["view", "body"])
  expect(budget.bytes).toBe(12)
  off()
})

test("all Scopes share a byte budget and one released reader cannot evict another reader", () => {
  const evicted: string[] = []
  const budget = createContentBudget(16)
  const first = budget.retain("scope-a:part")
  const second = budget.retain("scope-a:part")
  budget.publish("scope-a:part", "one", 12, () => evicted.push("a"))
  first()
  budget.publish("scope-b:part", "one", 12, () => evicted.push("b"))
  expect(evicted).toEqual(["b"])
  expect(budget.bytes).toBe(12)
  budget.publish("scope-a:part", "two", 8, () => evicted.push("new-a"))
  budget.remove("scope-a:part", "one")
  expect(budget.bytes).toBe(8)
  second()
  budget.publish("scope-c:part", "one", 12, () => evicted.push("c"))
  expect(evicted).toEqual(["b", "new-a"])
  expect(budget.bytes).toBe(12)
})
