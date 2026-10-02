import { expect, test } from "bun:test"
import {
  createFlight,
  aimFlight,
  startFlight,
  advanceFlight,
} from "../../../../src/components/session/welcome/flight/model"

test("the idle aircraft follows aiming without spawning enemies or consuming lives", () => {
  const state = aimFlight(createFlight(8), 40, 200)
  expect(state.ship).toEqual({ x: 40, y: 200 })
  expect(advanceFlight(state, 1)).toBe(state)
  expect(state.enemies).toHaveLength(0)
  expect(state.lives).toBe(3)
  expect(aimFlight(state, -200, 900).ship).toEqual({ x: 20, y: 380 })
})

test("shots destroy targets, collisions cost one life and grant temporary immunity", () => {
  const initial = startFlight(createFlight(4))
  const hit = advanceFlight(
    { ...initial, bullets: [{ x: 200, y: 90 }], enemies: [{ id: 1, x: 200, y: 80, age: 0, kind: 0 }], spawn: 1 },
    0.02,
  )
  expect(hit.score).toBe(100)
  expect(hit.enemies).toHaveLength(0)
  expect(hit.bursts).toHaveLength(1)
  const collision = advanceFlight(
    { ...initial, enemies: [{ id: 1, ...initial.ship, age: 0, kind: 0 }], spawn: 1 },
    0.01,
  )
  expect(collision.lives).toBe(2)
  const protectedState = advanceFlight({ ...collision, enemies: [{ id: 2, ...collision.ship, age: 0, kind: 0 }] }, 0.01)
  expect(protectedState.lives).toBe(2)
  const ended = advanceFlight(
    { ...initial, lives: 1, enemies: [{ id: 3, ...initial.ship, age: 0, kind: 0 }], spawn: 1 },
    0.01,
  )
  expect(ended.phase).toBe("over")
})

test("simulation stays deterministic and bounded through a long round", () => {
  const run = () => {
    let state = startFlight(createFlight(42))
    for (let i = 0; i < 12000; i++) state = advanceFlight({ ...state, lives: 3, invulnerable: 1 }, 1 / 60)
    return state
  }
  const state = run()
  expect(state).toEqual(run())
  expect(state.enemies.length).toBeLessThanOrEqual(24)
  expect(state.bullets.length).toBeLessThanOrEqual(48)
  expect(state.bursts.length).toBeLessThanOrEqual(32)
})
