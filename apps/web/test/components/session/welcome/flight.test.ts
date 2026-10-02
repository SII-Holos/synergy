import { expect, test } from "bun:test"
import {
  createFlight,
  aimFlight,
  startFlight,
  advanceFlight,
  type Flight,
} from "../../../../src/components/session/welcome/flight/model"

const enemy = (id = 1, x = 200, y = 80, kind = 0, hp = 1) => ({ id, x, y, origin: x, age: 0, kind, hp, flash: 0 })
const run = (state: Flight, seconds: number, fps = 120) => {
  for (let n = 0; n < seconds * fps; n++) state = advanceFlight(state, 1 / fps)
  return state
}
const pickup = (state: Flight, kind: "fire" | "shield" | "repair") =>
  advanceFlight({ ...state, pickups: [{ id: 90, ...state.ship, kind }], spawn: 99 }, 1 / 120)
const kill = (state: Flight, id = 1) =>
  advanceFlight({ ...state, bullets: [{ x: 200, y: 90, vx: 0 }], enemies: [enemy(id)], spawn: 99 }, 1 / 120)

test("idle aiming neither starts the round nor consumes lives", () => {
  const state = aimFlight(createFlight(8), 40, 200)
  expect(state.ship).toEqual({ x: 40, y: 200 })
  expect(advanceFlight(state, 1)).toBe(state)
  expect(state.enemies).toHaveLength(0)
  expect(state.lives).toBe(3)
  expect(aimFlight(state, -200, 900).ship).toEqual({ x: 20, y: 380 })
})

test("hits respect enemy durability and collisions cost only one life during immunity", () => {
  const initial = startFlight(createFlight(4))
  expect(kill(initial).score).toBe(100)
  const heavy = advanceFlight(
    { ...initial, bullets: [{ x: 200, y: 90, vx: 0 }], enemies: [enemy(1, 200, 80, 2, 3)], spawn: 99 },
    1 / 120,
  )
  expect(heavy.enemies[0]!.hp).toBe(2)
  expect(heavy.score).toBe(0)
  const collision = advanceFlight(
    { ...initial, enemies: [enemy(1, initial.ship.x, initial.ship.y)], spawn: 99 },
    1 / 120,
  )
  expect(collision.lives).toBe(2)
  const protectedState = advanceFlight(
    { ...collision, enemies: [enemy(2, collision.ship.x, collision.ship.y)] },
    1 / 120,
  )
  expect(protectedState.lives).toBe(2)
  const ended = advanceFlight(
    { ...initial, lives: 1, enemies: [enemy(3, initial.ship.x, initial.ship.y)], spawn: 99 },
    1 / 120,
  )
  expect(ended.phase).toBe("over")
})

test("the third kill guarantees fire, then every sixth cycles shield, fire and repair", () => {
  let state = startFlight(createFlight(4))
  const drops: string[] = []
  for (let n = 1; n <= 27; n++) {
    state = kill({ ...state, pickups: [] }, n)
    if (state.pickups.length) drops.push(`${n}:${state.pickups[0]!.kind}`)
  }
  expect(drops).toEqual(["3:fire", "9:shield", "15:fire", "21:repair", "27:shield"])
})

test("fire refreshes ten seconds of faster three-way shots and expires on simulation time", () => {
  const initial = startFlight(createFlight(4))
  const powered = pickup(initial, "fire")
  expect(powered.fire).toBe(10)
  const shot = advanceFlight({ ...powered, bullets: [], shot: 0 }, 1 / 120)
  expect(shot.bullets).toHaveLength(3)
  expect(shot.bullets.map((b) => b.vx)).toEqual([-140, 0, 140])
  const normal = run({ ...initial, spawn: 99 }, 0.5)
  expect(run({ ...powered, spawn: 99 }, 0.5).bullets.length).toBeGreaterThan(normal.bullets.length)
  const refreshed = pickup(run(powered, 3), "fire")
  expect(refreshed.fire).toBe(10)
  expect(run(refreshed, 10.1).fire).toBe(0)
})

test("shield absorbs one collision before health, while repair caps health and converts surplus to score", () => {
  const initial = startFlight(createFlight(4))
  const shield = pickup(initial, "shield")
  expect(shield.shield).toBe(8)
  const collision = advanceFlight(
    { ...shield, enemies: [enemy(1, shield.ship.x, shield.ship.y), enemy(2, shield.ship.x, shield.ship.y)] },
    1 / 120,
  )
  expect(collision.lives).toBe(3)
  expect(collision.shield).toBe(0)
  expect(collision.invulnerable).toBeGreaterThan(0)
  expect(run(shield, 8.1).shield).toBe(0)
  expect(pickup({ ...initial, lives: 2 }, "repair").lives).toBe(3)
  expect(pickup(initial, "repair").score).toBe(150)
})

test("missed enemies break a combo without costing a life", () => {
  const state = advanceFlight(
    { ...startFlight(createFlight(4)), combo: 7, spawn: 99, enemies: [enemy(1, 40, 421)] },
    1 / 120,
  )
  expect(state.lives).toBe(3)
  expect(state.combo).toBe(0)
  expect(state.enemies).toHaveLength(0)
})

test("render rates preserve gameplay and held steering, with bounded long-running collections", () => {
  const simulate = (fps: number) => {
    let state = { ...startFlight(createFlight(42)), invulnerable: 1000 }
    for (let i = 0; i < fps * 10; i++) state = advanceFlight(state, 1 / fps, { x: 0.1, y: 0 })
    return state
  }
  expect(simulate(30)).toEqual(simulate(120))
  expect(simulate(60)).toEqual(simulate(120))
  const state = run({ ...startFlight(createFlight(42)), invulnerable: 1000 }, 200, 60)
  expect(state.enemies.length).toBeLessThanOrEqual(24)
  expect(state.bullets.length).toBeLessThanOrEqual(64)
  expect(state.bursts.length).toBeLessThanOrEqual(32)
  expect(state.pickups.length).toBeLessThanOrEqual(8)
})
