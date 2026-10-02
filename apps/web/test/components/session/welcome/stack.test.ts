import { expect, test } from "bun:test"
import {
  createStack,
  dropBlock,
  advanceStack,
  stackLayout,
} from "../../../../src/components/session/welcome/stack/model"

const settle = (state: ReturnType<typeof createStack>) => {
  for (let i = 0; i < 36; i++) state = advanceStack(state, 1 / 120)
  return state
}
test("a drop captures its position, lands once and leaves no gaps between supported floors", () => {
  const falling = dropBlock(createStack(8))
  expect(falling.height).toBe(0)
  expect(dropBlock(falling)).toBe(falling)
  const placed = settle(falling)
  expect(placed.height).toBe(1)
  expect(placed.blocks.at(-1)!.x).toBe(250)
  const layers = stackLayout(placed)
  for (let i = 1; i < layers.length; i++) expect(layers[i]!.y + layers[i]!.height).toBe(layers[i - 1]!.y)
})
test("stacking continues past milestones with bounded history and camera, preserving perfect rewards", () => {
  let state = createStack(8)
  for (let i = 0; i < 100; i++) {
    state = settle(dropBlock({ ...state, moving: { ...state.moving, x: state.blocks.at(-1)!.x } }))
  }
  expect(state.phase).toBe("playing")
  expect(state.height).toBe(100)
  expect(state.blocks).toHaveLength(24)
  expect(state.bestCombo).toBe(100)
  expect(stackLayout(state).at(-1)!.y).toBeGreaterThan(50)
  expect(state.moving.width).toBe(220)
})
test("overhang is cut, perfect streaks restore width, and a miss preserves the tower", () => {
  let state = settle(dropBlock({ ...createStack(4), moving: { x: 300, width: 220, direction: 1 } }))
  expect(state.blocks.at(-1)!.width).toBe(170)
  expect(state.cut?.width).toBe(50)
  for (let i = 0; i < 3; i++)
    state = settle(dropBlock({ ...state, moving: { ...state.moving, x: state.blocks.at(-1)!.x } }))
  expect(state.blocks.at(-1)!.width).toBe(186)
  const lost = settle(dropBlock({ ...state, moving: { ...state.moving, x: 40 } }))
  expect(lost.phase).toBe("missed")
  expect(lost.blocks).toEqual(state.blocks)
})
test("idle motion and timed landings have the same result at 30, 60 and 120 Hz", () => {
  const run = (fps: number) => {
    let state = createStack(2)
    for (let i = 0; i < fps; i++) state = advanceStack(state, 1 / fps)
    state = dropBlock(state)
    for (let i = 0; i < fps; i++) state = advanceStack(state, 1 / fps)
    return state
  }
  expect(run(30)).toEqual(run(120))
  expect(run(60)).toEqual(run(120))
})
