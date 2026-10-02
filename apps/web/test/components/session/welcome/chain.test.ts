import { expect, test } from "bun:test"
import {
  createChain,
  igniteChain,
  advanceChain,
  chainHits,
  nextChain,
} from "../../../../src/components/session/welcome/chain/model"

test("a chain uses one ignition, propagates between nearby stars, and settles to a result", () => {
  const initial = createChain(8)
  expect(createChain(8)).toEqual(initial)
  const stars = initial.stars.map((star, i) => ({
    ...star,
    x: 180 + (i % 9) * 20,
    y: 100 + Math.floor(i / 9) * 20,
    vx: 0,
    vy: 0,
  }))
  let state = igniteChain({ ...initial, stars }, 180, 100)
  expect(igniteChain(state, 600, 200)).toBe(state)
  for (let i = 0; i < 240; i++) state = advanceChain(state, 1 / 30)
  expect(chainHits(state)).toBe(stars.length)
  expect(state.phase).toBe("won")
  expect(nextChain(state).round).toBe(1)
  expect(nextChain(state).phase).toBe("ready")
})

test("missing the stars ends the round and floating stars stay inside the playfield", () => {
  let state = createChain(17)
  for (let i = 0; i < 1000; i++) state = advanceChain(state, 0.05)
  expect(state.stars.every((s) => s.x >= 28 && s.x <= 692 && s.y >= 28 && s.y <= 272)).toBe(true)
  const far = state.stars.map((s) => ({ ...s, x: 650, y: 250, vx: 0, vy: 0 }))
  state = igniteChain({ ...state, stars: far }, 30, 30)
  for (let i = 0; i < 200; i++) state = advanceChain(state, 0.05)
  expect(state.phase).toBe("missed")
  expect(chainHits(state)).toBe(0)
  expect(nextChain(state).round).toBe(0)
  expect(advanceChain(state, 1)).toBe(state)
})
