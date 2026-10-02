import { expect, test } from "bun:test"
import {
  createOrbit,
  aimOrbit,
  launchOrbit,
  advanceOrbit,
  prepareOrbit,
  predictOrbit,
} from "../../../../src/components/session/welcome/orbit/model"

test("aiming is bounded and preview predicts the same flight without changing the model", () => {
  const initial = createOrbit(8)
  const before = structuredClone(initial)
  expect(predictOrbit(initial).length).toBeGreaterThan(5)
  expect(initial).toEqual(before)
  const aimed = aimOrbit(initial, -200, 900)
  expect(aimed.angle).toBe(-75)
  expect(aimed.power).toBe(440)
  const flying = launchOrbit(initial)
  expect(flying.phase).toBe("flying")
  expect(aimOrbit(flying, -20, 300)).toBe(flying)
  expect(launchOrbit(flying)).toBe(flying)
})

test("each authored delivery is reachable, gravity bends the path, and traces stay bounded", () => {
  for (let round = 0; round < 3; round++) {
    let state = launchOrbit(createOrbit(8, round))
    const vy = state.ship.vy
    state = advanceOrbit(state, 0.1)
    expect(state.ship.vy).not.toBe(vy)
    for (let i = 0; i < 200; i++) state = advanceOrbit(state, 0.05)
    expect(state.phase).toBe("delivered")
    expect(state.trace.length).toBeLessThanOrEqual(80)
    expect(advanceOrbit(state, 1)).toBe(state)
  }
})

test("collisions fail a shot, retry preserves the angle and three misses reset the attempt", () => {
  let state = launchOrbit(createOrbit(8))
  const planet = state.planets[0]!
  state = advanceOrbit({ ...state, ship: { x: planet.x, y: planet.y, vx: 1, vy: 1 } }, 0.05)
  expect(state.phase).toBe("missed")
  expect(prepareOrbit(state).shots).toBe(1)
  expect(prepareOrbit(state).angle).toBe(state.angle)
  expect(prepareOrbit({ ...state, shots: 3 }).shots).toBe(0)
})
