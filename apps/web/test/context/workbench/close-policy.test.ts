import { expect, test } from "bun:test"
import { createWorkbenchClosePolicy } from "../../../src/context/workbench/close-policy"

test("dirty resources negotiate before closing and released guards fall back to host confirmation", async () => {
  let confirmed = false
  let prompts = 0
  const policy = createWorkbenchClosePolicy(async () => {
    prompts++
    return confirmed
  })
  const tab = { id: "tab", panelId: "demo:panel", dirty: true }
  const release = policy.register("session-a", tab.id, async () => false)
  expect(await policy.canClose("session-a", tab)).toBe(false)
  expect(prompts).toBe(0)
  expect(await policy.canClose("session-b", tab)).toBe(false)
  expect(prompts).toBe(1)
  release()
  release()
  confirmed = true
  expect(await policy.canClose("session-a", tab)).toBe(true)
  expect(prompts).toBe(2)
  expect(await policy.canClose("session-a", { ...tab, dirty: false })).toBe(true)
  expect(prompts).toBe(2)
})

test("a failing close guard rejects the close instead of silently discarding a resource", async () => {
  const policy = createWorkbenchClosePolicy(async () => true)
  policy.register("a", "tab", async () => {
    throw new Error("save failed")
  })
  await expect(policy.canClose("a", { id: "tab", panelId: "demo:panel" })).rejects.toThrow("save failed")
})
