import { expect, test } from "bun:test"
import { BrowserHumanChanges } from "../src/human-changes"

test("human changes coalesce, block effects and require each session to observe", async () => {
  const changes = new BrowserHumanChanges("page")
  changes.record("pointer")
  changes.record("pointer")
  changes.record("keyboard")
  const effect = { type: "evaluate", expression: "submit()", mode: "trusted" } as const
  expect(() => changes.begin("one", effect)).toThrow("pointer: 2, keyboard: 1")
  const observation = changes.begin("one", { type: "snapshot" })
  expect(changes.finish(observation)).toContain("pointer: 2, keyboard: 1")
  expect(() => changes.begin("one", effect)).not.toThrow()
  expect(() => changes.begin("two", effect)).toThrow("Read the page again")
})

test("diagnostics and a failed or concurrent observation do not acknowledge new input", () => {
  const changes = new BrowserHumanChanges("page")
  changes.record("navigation")
  changes.finish(changes.begin("one", { type: "console", action: "list" }))
  const effect = { type: "reload" } as const
  expect(() => changes.begin("one", effect)).toThrow()
  changes.begin("one", { type: "snapshot" })
  expect(() => changes.begin("one", effect)).toThrow()
  const reading = changes.begin("one", { type: "screenshot" })
  changes.record("scroll")
  expect(changes.finish(reading)).toContain("during the observation")
  expect(() => changes.begin("one", effect)).toThrow("scroll: 1")
  changes.finish(changes.begin("one", { type: "snapshot" }))
  expect(() => changes.begin("one", effect)).not.toThrow()
})
