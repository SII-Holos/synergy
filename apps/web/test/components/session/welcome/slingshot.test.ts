import { expect, test } from "bun:test"
import { createSlingshot } from "../../../../src/components/session/welcome/slingshot/model"

const advance = (game: ReturnType<typeof createSlingshot>, seconds: number, fps = 120) => {
  for (let i = 0; i < seconds * fps; i++) game.advance(1 / fps)
  return game.snapshot()
}
test("stable structures remain intact until a shot and snapshots contain only restorable data", () => {
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
test("seeded challenges vary their structures, retry the same layout and do not repeat every six levels", () => {
  const layouts = new Set<string>()
  for (let seed = 1; seed <= 32; seed++) {
    const game = createSlingshot(seed)
    const first = game.snapshot().bodies
    layouts.add(JSON.stringify(first))
    expect(first.length).toBeGreaterThanOrEqual(7)
    advance(game, 1)
    game.retry()
    expect(game.snapshot().bodies).toEqual(first)
    const next = createSlingshot(seed, undefined, 6)
    expect(next.snapshot().bodies).not.toEqual(first)
    game.dispose()
    next.dispose()
  }
  expect(layouts.size).toBeGreaterThan(28)
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

test("varied challenges have reproducible solutions and carry banked points forward", () => {
  const solutions = [
    [8, 0, -20, 500],
    [8, 1, -20, 720],
    [8, 4, -20, 500],
    [8, 10, -20, 640],
    [37, 0, -20, 560],
    [37, 1, -20, 700],
    [37, 4, -25, 720],
    [37, 10, -20, 660],
    [103, 0, -55, 600],
    [103, 1, -25, 700],
    [103, 4, -25, 720],
    [103, 10, -20, 660],
  ] as const
  for (const [seed, level, angle, power] of solutions) {
    const game = createSlingshot(seed, undefined, level)
    advance(game, 2)
    game.aim(angle, power)
    game.launch()
    const won = advance(game, 8)
    expect(won.phase).toBe("won")
    expect(won.bodies.some((b) => b.kind === "target")).toBe(false)
    expect(won.stars).toBe(3)
    expect(won.bodies.length).toBeLessThanOrEqual(48)
    game.next()
    expect(game.snapshot().level).toBe(level + 1)
    expect(game.snapshot().score).toBe(won.score)
    expect(game.snapshot().shots).toBe(3)
    game.dispose()
  }
})

test("generated load-bearing structures stay in place across seeds and bounded late-game complexity", () => {
  for (let seed = 1; seed <= 64; seed++)
    for (const level of [0, 2, 6, 20]) {
      const game = createSlingshot(seed, undefined, level)
      const initial = game.snapshot().bodies
      const state = advance(game, 3, 30)
      expect(state.bodies.length).toBeLessThanOrEqual(45)
      expect(state.bodies.length).toBe(initial.length)
      for (const [index, body] of state.bodies.entries()) {
        expect(Math.hypot(body.x - initial[index]!.x, body.y - initial[index]!.y)).toBeLessThan(5)
        expect(Math.abs(body.angle)).toBeLessThan(0.08)
        expect(body.x - body.width / 2).toBeGreaterThan(330)
        expect(body.x + body.width / 2).toBeLessThan(710)
        expect(body.y - body.height / 2).toBeGreaterThan(40)
      }
      game.dispose()
    }
})

test("remaining ammunition determines stars after a delayed successful shot", () => {
  for (const misses of [1, 2]) {
    const game = createSlingshot(8)
    advance(game, 2)
    for (let i = 0; i < misses; i++) {
      game.aim(-80, 160)
      game.launch()
      advance(game, 9)
    }
    game.aim(-20, 520)
    game.launch()
    expect(advance(game, 8).phase).toBe("won")
    expect(game.snapshot().stars).toBe(3 - misses)
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

test("destroying a sleeping support wakes the roof and lets it fall before settling", () => {
  const source = createSlingshot(8)
  const snapshot = source.snapshot()
  source.dispose()
  const still = { angle: 0, vx: 0, vy: 0, spin: 0, sleeping: true }
  const game = createSlingshot(8, {
    ...snapshot,
    phase: "flying",
    shots: 2,
    bodies: [
      { ...still, id: 1, kind: "wood", x: 500, y: 290, width: 12, height: 60 },
      { ...still, id: 2, kind: "stone", x: 500, y: 252, width: 120, height: 16 },
      { ...still, id: 3, kind: "target", x: 670, y: 308, width: 24, height: 24, radius: 12 },
      { ...still, id: 100, kind: "bird", x: 450, y: 294, width: 22, height: 22, radius: 11, vx: 620, sleeping: false },
    ],
  })
  const hit = advance(game, 0.2)
  expect(hit.bodies.some((b) => b.id === 1)).toBe(false)
  expect(hit.bodies.find((b) => b.id === 2)!.sleeping).toBe(false)
  expect(hit.phase).toBe("flying")
  expect(advance(game, 1).bodies.find((b) => b.id === 2)!.y).toBeGreaterThan(280)
  game.dispose()
})

test("a missed shot does not make an untouched structure win, across challenge levels", () => {
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
