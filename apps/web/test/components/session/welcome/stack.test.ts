import { expect, test } from "bun:test"
import { createStack, dropBlock, advanceStack } from "../../../../src/components/session/welcome/stack/model"

test("aligned drops build a complete tower and restore width after a perfect streak", () => {
  let state = dropBlock(createStack(8))
  expect(state.blocks).toHaveLength(2)
  expect(state.last).toBe("perfect")
  for (let i = 0; i < 11; i++) {
    const top = state.blocks.at(-1)!
    state = dropBlock({ ...state, cooldown: 0, moving: { ...state.moving, x: top.x } })
  }
  expect(state.phase).toBe("won")
  expect(state.bestCombo).toBe(12)
  expect(dropBlock(state)).toBe(state)
  expect(advanceStack(state, 0.1).blocks).toEqual(state.blocks)
})

test("overhang is cut from the next block, a miss ends the game, and a rapid second drop is ignored", () => {
  const initial = dropBlock(createStack(4))
  expect(dropBlock(initial)).toBe(initial)
  const placed = dropBlock({ ...initial, cooldown: 0, moving: { ...initial.moving, x: 300 } })
  expect(placed.blocks.at(-1)!.width).toBe(170)
  expect(placed.cut?.width).toBe(50)
  expect(placed.combo).toBe(0)
  const lost = dropBlock({ ...placed, cooldown: 0, moving: { ...placed.moving, x: 40 } })
  expect(lost.phase).toBe("missed")
  expect(lost.blocks).toEqual(placed.blocks)
  const moved = advanceStack(initial, 0.05)
  expect(moved.moving.x).not.toBe(initial.moving.x)
  expect(moved.blocks).toEqual(initial.blocks)
})
