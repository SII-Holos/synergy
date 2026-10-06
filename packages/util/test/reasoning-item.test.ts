import { expect, test } from "bun:test"
import { reasoningItemKey } from "../src/reasoning-item"

test("reasoning identity is scoped to one unambiguous provider item", () => {
  expect(reasoningItemKey({ "openai-codex": { itemId: "rs_1" } })).toBe('["openai-codex","rs_1"]')
  expect(reasoningItemKey({ openai: { itemId: "rs_1" } })).not.toBe(
    reasoningItemKey({ "openai-codex": { itemId: "rs_1" } }),
  )
  for (const metadata of [
    undefined,
    null,
    [],
    "item",
    { p: {} },
    { p: { itemId: 1 } },
    { p: { itemId: " " } },
    { p: { itemId: "x".repeat(1025) } },
    { p: { itemId: "a" }, q: { itemId: "b" } },
  ]) {
    expect(reasoningItemKey(metadata)).toBeUndefined()
  }
})
