import { expect, test } from "bun:test"
import { createPartArrivalState } from "../../src/context/part-arrival"

test("only new live renderable Parts in a ready foreground view receive a single arrival", () => {
  let time = 0
  const state = createPartArrivalState(() => time)
  const owner = ["server", "scope", "session"]
  const view = state.open(owner)
  state.add(owner, "before-baseline", { source: "live", render: true, previous: undefined })
  view.ready(true)
  expect(view.revision()).toBe(0)
  for (const source of ["replay", "discovery"] as const)
    state.add(owner, source, { source, render: true, previous: undefined })
  state.add(owner, "existing", { source: "live", render: true, previous: true })
  state.add(owner, "empty", { source: "live", render: false, previous: undefined })
  for (const id of ["before-baseline", "replay", "discovery", "existing", "empty"]) expect(view.take(id)).toBe(false)
  expect(view.revision()).toBe(1)
  state.add(owner, "readable", { source: "live", render: true, previous: false })
  expect(view.take("readable")).toBe(true)
  expect(view.revision()).toBe(2)
  expect(view.take("readable")).toBe(false)
  state.add(owner, "readable", { source: "live", render: true, previous: false })
  expect(view.take("readable")).toBe(false)
  state.add(owner, "expired", { source: "live", render: true, previous: undefined })
  time = 2001
  expect(view.take("expired")).toBe(false)
})

test("view replacement fences pending arrivals and stale cleanup, and keeps its queue bounded", () => {
  const state = createPartArrivalState()
  const owner = ["server", "scope", "session"]
  const first = state.open(owner)
  first.ready(true)
  state.add(owner, "old", { source: "live", render: true, previous: undefined })
  const second = state.open(owner)
  second.ready(true)
  first.release()
  expect(first.take("old")).toBe(false)
  expect(second.take("old")).toBe(false)
  state.add(["other-server", "scope", "session"], "foreign", { source: "live", render: true, previous: undefined })
  expect(second.take("foreign")).toBe(false)
  for (let index = 0; index < 100; index++)
    state.add(owner, `part-${index}`, { source: "live", render: true, previous: undefined })
  expect(second.take("part-0")).toBe(false)
  expect(second.take("part-99")).toBe(true)
  second.release()
  expect(second.take("part-98")).toBe(false)
})
