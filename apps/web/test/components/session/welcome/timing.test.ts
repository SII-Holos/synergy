import { expect, test } from "bun:test"
import { advanceFixed, sceneStep } from "../../../../src/components/session/welcome/timing"

test("fixed steps carry fractions and bound stalls without losing ordinary frame time", () => {
  const update = (s: { remainder: number; ticks: number }) => ({ ...s, ticks: s.ticks + 1 })
  for (const fps of [30, 60, 120]) {
    let state = { remainder: 0, ticks: 0 }
    for (let i = 0; i < fps; i++) state = advanceFixed(state, 1 / fps, update)
    expect(state).toEqual({ remainder: 0, ticks: 120 })
  }
  const half = advanceFixed({ remainder: 0, ticks: 0 }, sceneStep / 2, update)
  expect(advanceFixed(half, sceneStep / 2, update).ticks).toBe(1)
  expect(advanceFixed(half, 60, update).ticks).toBe(12)
  expect(advanceFixed(half, NaN, update)).toBe(half)
})
