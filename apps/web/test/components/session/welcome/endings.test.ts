import { expect, test } from "bun:test"
import { advanceFlight, createFlight, startFlight } from "../../../../src/components/session/welcome/flight/model"
import { advanceStack, createStack, dropBlock } from "../../../../src/components/session/welcome/stack/model"
import { advanceBlocks, createBlocks, dropBlocks } from "../../../../src/components/session/welcome/blocks/model"
import { createSlingshot } from "../../../../src/components/session/welcome/slingshot/model"

function advance<T>(state: T, step: (state: T, dt: number) => T, seconds: number, fps = 120): T {
  for (let i = 0; i < Math.round(seconds * fps); i++) state = step(state, 1 / fps)
  return state
}

test("a flight loss coasts existing objects to rest without continuing combat or scoring", () => {
  const initial = startFlight(createFlight(7))
  const enemy = (id: number, x: number, y: number) => ({ id, x, y, origin: x, age: 0, kind: 0, hp: 1, flash: 0 })
  const lost = advanceFlight(
    {
      ...initial,
      lives: 1,
      spawn: 99,
      shot: 99,
      enemies: [enemy(1, initial.ship.x, initial.ship.y), enemy(2, 80, 70)],
      bullets: [{ x: 80, y: 110, vx: 0 }],
      pickups: [{ id: 9, x: 150, y: 110, kind: "repair" }],
    },
    1 / 120,
  )
  expect(lost.phase).toBe("over")
  const middle = advance(lost, advanceFlight, 0.3)
  expect(middle.enemies[0]!.y).toBeGreaterThan(lost.enemies[0]!.y)
  expect(middle.bullets[0]!.y).toBeLessThan(lost.bullets[0]!.y)
  expect(middle.pickups[0]!.y).toBeGreaterThan(lost.pickups[0]!.y)
  expect(middle.ship).toEqual(lost.ship)
  expect(middle.score).toBe(lost.score)
  expect(middle.kills).toBe(lost.kills)
  expect(middle.lives).toBe(0)
  const ended = advance(lost, advanceFlight, 2)
  expect(ended.ending).toBe(1)
  expect(ended.enemies).toHaveLength(0)
  expect(ended.bullets).toHaveLength(0)
  expect(ended.pickups).toHaveLength(0)
  expect(ended.bursts).toHaveLength(0)
  expect(advance(lost, advanceFlight, 1, 30)).toEqual(advance(lost, advanceFlight, 1, 120))
  expect(createFlight(7).ending).toBe(0)
})

test("a missed floor finishes falling while retaining the completed tower and result", () => {
  const initial = createStack(7)
  const lost = advance(dropBlock({ ...initial, moving: { ...initial.moving, x: 0 } }), advanceStack, 0.2)
  expect(lost.phase).toBe("missed")
  const middle = advance(lost, advanceStack, 0.3)
  expect(middle.ending).toBeGreaterThan(lost.ending)
  expect(middle.cut!.age).toBeGreaterThan(lost.cut!.age)
  const ended = advance(lost, advanceStack, 2)
  expect(ended.ending).toBe(1)
  expect(ended.blocks).toEqual(initial.blocks)
  expect(ended.height).toBe(0)
  expect(ended.cut).toBeUndefined()
})

test("block top-out advances result presentation without clearing or changing the final board", () => {
  const initial = createBlocks(8)
  for (let y = 2; y < 20; y++) for (let x = 3; x < 7; x++) initial.board[y * 10 + x] = 1
  const lost = dropBlocks(initial)
  expect(lost.phase).toBe("over")
  const middle = advance(lost, advanceBlocks, 0.3)
  expect(middle.ending).toBeGreaterThan(0)
  expect(middle.board).toEqual(lost.board)
  expect(middle.score).toBe(lost.score)
  expect(advance(lost, advanceBlocks, 2).ending).toBe(1)
  expect(createBlocks(8).ending).toBe(0)
})

test("slingshot results retain score and layout during feedback and reset for retry or the next level", () => {
  for (const phase of ["won", "lost"] as const) {
    const initial = createSlingshot(8)
    const snapshot = { ...initial.snapshot(), phase, score: 600, stars: phase === "won" ? 2 : 0 }
    initial.dispose()
    const game = createSlingshot(8, snapshot)
    try {
      for (let i = 0; i < 36; i++) game.advance(1 / 120)
      const middle = game.snapshot()
      expect(middle.ending).toBeGreaterThan(0)
      expect(middle.score).toBe(600)
      expect(middle.bodies).toEqual(snapshot.bodies)
      const restored = createSlingshot(8, middle)
      try {
        for (let i = 0; i < 240; i++) restored.advance(1 / 120)
        expect(restored.snapshot().ending).toBe(1)
        if (phase === "won") restored.next()
        else restored.retry()
        expect(restored.snapshot().ending).toBe(0)
        expect(restored.snapshot().phase).toBe("aiming")
      } finally {
        restored.dispose()
      }
    } finally {
      game.dispose()
    }
  }
})
