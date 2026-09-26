import { expect, test } from "bun:test"
import { createModelSelectionWriter, thinkingChoices, thinkingValue } from "../../../src/context/prompt/model-selection"

test("selection writes use the last accepted revision before events arrive", async () => {
  let revision = 1
  const seen: number[] = []
  const writer = createModelSelectionWriter()
  const write = () =>
    writer.enqueue("session", async () => {
      seen.push(revision)
      await Promise.resolve()
      revision++
    })
  await Promise.all([write(), write(), write()])
  expect(seen).toEqual([1, 2, 3])
})

test("a failed write does not prevent later choices or serialize another session", async () => {
  const writer = createModelSelectionWriter()
  const values: string[] = []
  const first = writer.enqueue("a", async () => {
    throw new Error("offline")
  })
  const second = writer.enqueue("a", async () => {
    values.push("a")
  })
  await writer.enqueue("b", async () => {
    values.push("b")
  })
  await expect(first).rejects.toThrow("offline")
  await second
  expect(values.sort()).toEqual(["a", "b"])
})

test("Default and Off have distinct meanings and share the same ordered choices", () => {
  expect(thinkingChoices(["high", "off", "low"])).toEqual(["", "off", "high", "low"])
  expect(thinkingChoices([])).toEqual([""])
  expect(thinkingValue({ mode: "provider-default" })).toBeUndefined()
  expect(thinkingValue({ mode: "off" })).toBe("off")
})
