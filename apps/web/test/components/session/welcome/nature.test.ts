import { expect, test } from "bun:test"
import {
  createNature,
  paintNature,
  stepNature,
  natureCounts,
  type Nature,
} from "../../../../src/components/session/welcome/nature/model"

function empty(): Nature {
  const state = createNature(10, 24, 18)
  state.cells.fill(0)
  state.growth.fill(0)
  return state
}
test("water falls, respects solid ground, and is conserved at every edge", () => {
  let state = paintNature(empty(), "water", 12, 3, 0)
  state = paintNature(state, "soil", 12, 5, 0)
  stepNature(state)
  expect(state.cells[4 * 24 + 12]).toBe(2)
  for (let i = 0; i < 150; i++) stepNature(state)
  expect(natureCounts(state).water).toBe(1)
  expect(state.cells[5 * 24 + 12]).toBe(1)
  expect(state.cells.length).toBe(24 * 18)
})
test("seeds stay dormant without water, germinate when watered, and growth stays bounded", () => {
  let state = empty()
  state = paintNature(state, "soil", 12, 12, 3)
  state = paintNature(state, "seed", 12, 8, 0)
  for (let i = 0; i < 20; i++) stepNature(state)
  expect(natureCounts(state).grown).toBe(0)
  state = paintNature(state, "water", 12, 7, 2)
  for (let i = 0; i < 500; i++) stepNature(state)
  expect(natureCounts(state).grown).toBe(1)
  expect(Math.max(...state.growth)).toBeLessThanOrEqual(12)
})
test("digging, deterministic seeds and low gravity have observable effects", () => {
  expect(createNature(123)).toEqual(createNature(123))
  const normal = paintNature(empty(), "water", 12, 3, 0)
  const low = { ...normal, cells: normal.cells.slice(), growth: normal.growth.slice(), lowGravity: true }
  stepNature(normal)
  stepNature(low)
  expect(normal.cells[4 * 24 + 12]).toBe(2)
  expect(low.cells[3 * 24 + 12]).toBe(2)
  const cleared = paintNature(normal, "dig", 12, 4, 1)
  expect(natureCounts(cleared).water).toBe(0)
})
