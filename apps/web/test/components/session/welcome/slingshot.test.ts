import { expect, test } from "bun:test"
import { createSlingshot, slingshotLevels } from "../../../../src/components/session/welcome/slingshot/model"

const advance = (game: ReturnType<typeof createSlingshot>, seconds: number, fps = 120) => {
  for (let i = 0; i < seconds * fps; i++) game.advance(1 / fps)
  return game.snapshot()
}
test("six stable structures remain intact until a shot and snapshots contain only restorable data", () => {
  expect(slingshotLevels).toHaveLength(6)
  for (let level = 0; level < 6; level++) {
    const game = createSlingshot(8, undefined, level)
    const before = game.snapshot().bodies.filter((b) => b.kind === "target").length
    const state = advance(game, 2)
    expect(state.phase).toBe("aiming")
    expect(state.shots).toBe(3)
    expect(state.bodies.filter((b) => b.kind === "target")).toHaveLength(before)
    expect(state.bodies.length).toBeLessThanOrEqual(48)
    const restored = createSlingshot(8, JSON.parse(JSON.stringify(state)))
    expect(restored.snapshot()).toEqual(state)
    game.dispose()
    restored.dispose()
  }
})
test("prediction follows the same free flight and a launch spends exactly one shot", () => {
  const game = createSlingshot(8)
  game.aim(-55, 620)
  const trajectory = game.predict()
  game.launch()
  game.launch()
  expect(game.snapshot().shots).toBe(2)
  for (let i = 1; i <= 4; i++) {
    advance(game, 0.05)
    const bird = game.snapshot().bodies.find((b) => b.kind === "bird")!
    expect(bird.x).toBeCloseTo(trajectory[i]!.x, 2)
    expect(bird.y).toBeCloseTo(trajectory[i]!.y, 2)
  }
  const snapshot = game.snapshot()
  game.dispose()
  game.advance(2)
  expect(game.snapshot()).toEqual(snapshot)
})
test("three missed shots lose only after settling and retry resets the current level", () => {
  const game = createSlingshot(7, undefined, 2)
  for (let i = 0; i < 3; i++) {
    game.aim(-80, 180)
    game.launch()
    expect(game.snapshot().phase).toBe("flying")
    advance(game, 9)
  }
  expect(game.snapshot().phase).toBe("lost")
  game.retry()
  expect(game.snapshot().level).toBe(2)
  expect(game.snapshot().shots).toBe(3)
  game.dispose()
})
test("fixed stepping preserves flight results across render rates and mid-flight remounts", () => {
  const run = (fps: number) => {
    const game = createSlingshot(3)
    game.aim(-55, 620)
    game.launch()
    const state = advance(game, 0.5, fps)
    game.dispose()
    return state
  }
  expect(run(30)).toEqual(run(120))
  expect(run(60)).toEqual(run(120))
  const game = createSlingshot(3)
  game.aim(-55, 620)
  game.launch()
  advance(game, 0.25)
  const restored = createSlingshot(3, game.snapshot())
  advance(game, 0.25)
  advance(restored, 0.25)
  const bird = game.snapshot().bodies.find((b) => b.kind === "bird")!
  const other = restored.snapshot().bodies.find((b) => b.kind === "bird")!
  expect(other.x).toBeCloseTo(bird.x, 2)
  expect(other.y).toBeCloseTo(bird.y, 2)
  game.dispose()
  restored.dispose()
})

test("every authored level has reproducible winning shots and advances with banked points", () => {
  const solutions = [
    [[-65, 640]],
    [
      [-65, 620],
      [-65, 700],
    ],
    [[-44, 600]],
    [
      [-23, 640],
      [-65, 540],
    ],
    [[-32, 620]],
    [
      [-20, 700],
      [-65, 580],
    ],
  ]
  for (const [level, shots] of solutions.entries()) {
    const game = createSlingshot(8, undefined, level)
    for (const [angle, power] of shots) {
      game.aim(angle!, power!)
      game.launch()
      advance(game, 10)
      expect(game.snapshot().bodies.length).toBeLessThanOrEqual(48)
    }
    const won = game.snapshot()
    expect(won.phase).toBe("won")
    expect(won.bodies.some((b) => b.kind === "target")).toBe(false)
    expect(won.stars).toBe(4 - shots.length)
    game.next()
    expect(game.snapshot().level).toBe(level + 1)
    expect(game.snapshot().score).toBe(won.score)
    expect(game.snapshot().shots).toBe(3)
    game.dispose()
  }
})

test("a falling stone can destroy a target without a direct bird hit", () => {
  const source = createSlingshot(8)
  const snapshot = source.snapshot()
  source.dispose()
  const target = snapshot.bodies.find((b) => b.kind === "target")!
  const state = {
    ...snapshot,
    phase: "flying" as const,
    bodies: [
      target,
      { ...target, id: 99, kind: "stone" as const, y: 220, vy: 250, radius: undefined, width: 24, height: 24 },
    ],
  }
  const game = createSlingshot(8, state)
  expect(advance(game, 5).phase).toBe("won")
  expect(game.snapshot().score).toBeGreaterThan(0)
  expect(game.snapshot().bursts).toEqual([])
  game.dispose()
})

test("a missed shot does not make an untouched structure win, at any authored level", () => {
  for (let level = 0; level < 6; level++) {
    const game = createSlingshot(8, undefined, level)
    const targets = game.snapshot().bodies.filter((b) => b.kind === "target").length
    game.aim(-80, 160)
    game.launch()
    const state = advance(game, 10)
    expect(state.phase).toBe("aiming")
    expect(state.bodies.filter((b) => b.kind === "target")).toHaveLength(targets)
    game.dispose()
  }
})

test("collision outcomes are frame-rate independent and contact snapshots resume the challenge", () => {
  const simulate = (fps: number) => {
    const game = createSlingshot(8)
    game.aim(-65, 640)
    game.launch()
    const result = advance(game, 10, fps)
    game.dispose()
    return result
  }
  expect(simulate(30)).toEqual(simulate(120))
  expect(simulate(60)).toEqual(simulate(120))
  const game = createSlingshot(8)
  game.aim(-65, 640)
  game.launch()
  advance(game, 1.9)
  const restored = createSlingshot(8, JSON.parse(JSON.stringify(game.snapshot())))
  const original = advance(game, 8),
    resumed = advance(restored, 8)
  expect(resumed.phase).toBe(original.phase)
  expect(resumed.score).toBe(original.score)
  expect(resumed.shots).toBe(original.shots)
  expect(resumed.bodies.length).toBeLessThanOrEqual(48)
  game.dispose()
  restored.dispose()
})
