import Matter from "matter-js"
import { advanceFixed, sceneStep } from "../timing"
import { createSlingLevel, type Shape } from "./levels"

const { Bodies, Body, Composite, Engine, Events, Query, Sleeping } = Matter
export const slingAnchor = { x: 98, y: 224 }
export const slingGravity = 750
export type Point = { x: number; y: number }
export type SlingBody = Shape & { id: number; angle: number; vx: number; vy: number; spin: number; sleeping: boolean }
export type SlingSnapshot = {
  seed: number
  level: number
  banked: number
  score: number
  shots: number
  stars: number
  phase: "aiming" | "flying" | "won" | "lost"
  angle: number
  power: number
  elapsed: number
  settled: number
  remainder: number
  sequence: number
  bodies: SlingBody[]
  bursts: (Point & { age: number; kind: Shape["kind"] })[]
}
export function slingOrigin(angle: number, power: number): Point {
  const radians = (angle * Math.PI) / 180
  return { x: slingAnchor.x - (Math.cos(radians) * power) / 9.5, y: slingAnchor.y - (Math.sin(radians) * power) / 9.5 }
}
const initial = (seed: number, level: number, banked = 0): SlingSnapshot => ({
  seed,
  level,
  banked,
  score: banked,
  shots: 3,
  stars: 0,
  phase: "aiming",
  angle: -35,
  power: 600,
  elapsed: 0,
  settled: 0,
  remainder: 0,
  sequence: 100,
  bodies: createSlingLevel(seed, level).map((shape, id) => ({
    ...shape,
    id,
    angle: 0,
    vx: 0,
    vy: 0,
    spin: 0,
    sleeping: false,
  })),
  bursts: [],
})

// Fixed-step rigid body integration: https://brm.io/matter-js/docs/classes/Engine.html (0.20.0).
export function createSlingshot(seed: number, restored?: SlingSnapshot, level = 0) {
  let state = restored ? structuredClone(restored) : initial(seed, level)
  const engine = Engine.create({ enableSleeping: true, gravity: { x: 0, y: 1, scale: slingGravity / 1e6 } })
  const bodies = new Map<number, { shape: SlingBody; body: Matter.Body }>()
  let disposed = false
  const removed = new Set<number>()
  function add(shape: SlingBody) {
    const options = {
      label: String(shape.id),
      angle: shape.angle,
      friction: 0.6,
      frictionAir: 0,
      restitution: shape.kind === "bird" ? 0.3 : 0.08,
      density: shape.kind === "stone" ? 0.004 : shape.kind === "bird" ? 0.006 : 0.0015,
    }
    const body = shape.radius
      ? Bodies.circle(shape.x, shape.y, shape.radius, options)
      : Bodies.rectangle(shape.x, shape.y, shape.width, shape.height, options)
    Body.setVelocity(body, { x: shape.vx / 60, y: shape.vy / 60 })
    Body.setAngularVelocity(body, shape.spin / 60)
    Sleeping.set(body, shape.sleeping)
    bodies.set(shape.id, { shape, body })
    Composite.add(engine.world, body)
  }
  function populate() {
    Composite.clear(engine.world, false)
    Engine.clear(engine)
    bodies.clear()
    removed.clear()
    Composite.add(engine.world, Bodies.rectangle(360, 333, 1440, 26, { isStatic: true, friction: 0.8 }))
    state.bodies.forEach(add)
  }
  function readBodies(): SlingBody[] {
    return [...bodies.values()].map(({ shape, body }) => {
      const velocity = Body.getVelocity(body)
      return {
        ...shape,
        x: body.position.x,
        y: body.position.y,
        angle: body.angle,
        vx: velocity.x * 60,
        vy: velocity.y * 60,
        spin: Body.getAngularVelocity(body) * 60,
        sleeping: body.isSleeping,
      }
    })
  }
  const collisions = (event: Matter.IEventCollision<Matter.Engine>) => {
    if (state.phase !== "flying") return
    for (const pair of event.pairs) {
      const a = Body.getVelocity(pair.bodyA),
        b = Body.getVelocity(pair.bodyB)
      const normal = pair.collision.normal
      const speed = Math.abs((a.x - b.x) * normal.x + (a.y - b.y) * normal.y) * 60
      for (const body of [pair.bodyA, pair.bodyB]) {
        const entry = bodies.get(Number(body.label))
        if (!entry) continue
        if ((entry.shape.kind === "target" && speed > 80) || (entry.shape.kind === "wood" && speed > 180))
          removed.add(entry.shape.id)
      }
    }
  }
  Events.on(engine, "collisionStart", collisions)
  populate()
  function tick(current: SlingSnapshot, dt: number): SlingSnapshot {
    state = current
    const bursts = state.bursts.map((b) => ({ ...b, age: b.age + dt })).filter((b) => b.age < 0.55)
    if (state.phase === "won" || state.phase === "lost") return { ...state, bursts }
    Engine.update(engine, dt * 1000)
    let score = state.score
    for (const [id, { body, shape }] of bodies) {
      if (body.position.x < -80 || body.position.x > 800 || body.position.y > 480) removed.add(id)
      if (!removed.has(id)) continue
      if (shape.kind === "target") score += 100
      bursts.push({ ...body.position, kind: shape.kind, age: 0 })
      Composite.remove(engine.world, body)
      bodies.delete(id)
    }
    if (removed.size) for (const { body } of bodies.values()) Sleeping.set(body, false)
    removed.clear()
    const snapshot = readBodies()
    const elapsed = state.phase === "flying" ? state.elapsed + dt : state.elapsed
    const quiet = snapshot.every((b) => b.sleeping || (Math.hypot(b.vx, b.vy) < 12 && Math.abs(b.spin) < 0.15))
    const settled = quiet ? state.settled + dt : 0
    let phase: SlingSnapshot["phase"] = state.phase,
      stars = state.stars
    if (phase === "flying" && elapsed > 0.4 && settled > 0.45) {
      if (!snapshot.some((b) => b.kind === "target")) {
        phase = "won"
        stars = Math.min(3, state.shots + 1)
        score += 200 + state.shots * 100
      } else phase = state.shots ? "aiming" : "lost"
    }
    return { ...state, bodies: snapshot, elapsed, settled, phase, stars, score, bursts: bursts.slice(-24) }
  }
  return {
    snapshot: () => structuredClone(state),
    aim(angle: number, power: number) {
      if (disposed || state.phase !== "aiming" || !Number.isFinite(angle + power)) return
      state = { ...state, angle: Math.max(-80, Math.min(-8, angle)), power: Math.max(160, Math.min(720, power)) }
    },
    launch() {
      if (disposed || state.phase !== "aiming" || state.shots <= 0) return
      const angle = (state.angle * Math.PI) / 180
      const origin = slingOrigin(state.angle, state.power)
      add({
        id: state.sequence,
        kind: "bird",
        ...origin,
        width: 22,
        height: 22,
        radius: 11,
        angle: 0,
        vx: Math.cos(angle) * state.power,
        vy: Math.sin(angle) * state.power,
        spin: 0,
        sleeping: false,
      })
      state = {
        ...state,
        sequence: state.sequence + 1,
        shots: state.shots - 1,
        phase: "flying",
        elapsed: 0,
        settled: 0,
        bodies: readBodies(),
      }
    },
    advance(seconds: number) {
      if (disposed) return
      state = advanceFixed(state, seconds, tick)
    },
    predict(): Point[] {
      if (disposed || state.phase !== "aiming") return []
      const point = slingOrigin(state.angle, state.power),
        angle = (state.angle * Math.PI) / 180
      const vx = Math.cos(angle) * state.power
      let vy = Math.sin(angle) * state.power
      const points = [{ ...point }]
      const probe = Bodies.circle(point.x, point.y, 11)
      const obstacles = Composite.allBodies(engine.world)
      for (let i = 1; i <= 216; i++) {
        vy += slingGravity * sceneStep
        point.x += vx * sceneStep
        point.y += vy * sceneStep
        Body.setPosition(probe, point)
        if (Query.collides(probe, obstacles).length || point.x > 730 || point.y > 330) break
        if (i % 6 === 0) points.push({ ...point })
      }
      return points
    },
    retry() {
      if (disposed) return
      state = initial(seed, state.level, state.banked)
      populate()
    },
    next() {
      if (disposed || state.phase !== "won") return
      state = initial(seed, state.level + 1, state.score)
      populate()
    },
    dispose() {
      if (disposed) return
      disposed = true
      Events.off(engine, "collisionStart", collisions)
      Composite.clear(engine.world, false)
      Engine.clear(engine)
      bodies.clear()
    },
  }
}
