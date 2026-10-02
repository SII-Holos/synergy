import { sceneRandom } from "../random"

export type Flight = {
  seed: number
  phase: "ready" | "playing" | "over"
  ship: { x: number; y: number }
  enemies: { id: number; x: number; y: number; age: number; kind: number }[]
  bullets: { x: number; y: number }[]
  bursts: { x: number; y: number; age: number }[]
  lives: number
  score: number
  time: number
  spawn: number
  shot: number
  sequence: number
  invulnerable: number
}
export function createFlight(seed: number): Flight {
  return {
    seed,
    phase: "ready",
    ship: { x: 360, y: 330 },
    enemies: [],
    bullets: [],
    bursts: [],
    lives: 3,
    score: 0,
    time: 0,
    spawn: 0.1,
    shot: 0,
    sequence: 0,
    invulnerable: 0,
  }
}
export function aimFlight(state: Flight, x: number, y: number): Flight {
  if (state.phase === "over" || !Number.isFinite(x + y)) return state
  return { ...state, ship: { x: Math.max(20, Math.min(700, x)), y: Math.max(100, Math.min(380, y)) } }
}
export function startFlight(state: Flight): Flight {
  return state.phase === "ready" ? { ...state, phase: "playing" } : state
}
export function advanceFlight(state: Flight, seconds: number): Flight {
  if (state.phase !== "playing" || seconds <= 0 || !Number.isFinite(seconds)) return state
  const dt = Math.min(seconds, 1 / 30)
  const time = state.time + dt
  let score = state.score,
    lives = state.lives,
    invulnerable = Math.max(0, state.invulnerable - dt)
  let spawn = state.spawn - dt,
    shot = state.shot - dt,
    sequence = state.sequence
  let enemies = state.enemies.map((e) => ({
    ...e,
    age: e.age + dt,
    y: e.y + (40 + Math.min(40, time / 4) + e.kind * 15) * dt,
    x: e.x + Math.sin(e.age * 2 + e.id) * dt * 20,
  }))
  let bullets = state.bullets.map((b) => ({ ...b, y: b.y - 420 * dt })).filter((b) => b.y > -10)
  const bursts = state.bursts.map((b) => ({ ...b, age: b.age + dt })).filter((b) => b.age < 0.45)
  if (spawn <= 0 && enemies.length < 24) {
    const random = sceneRandom(state.seed + sequence * 7919)
    enemies.push({ id: sequence++, x: 40 + random() * 640, y: -20, age: 0, kind: Math.floor(random() * 3) })
    spawn = Math.max(0.3, 0.85 - time / 160)
  }
  if (shot <= 0) {
    bullets.push({ x: state.ship.x - 6, y: state.ship.y - 18 }, { x: state.ship.x + 6, y: state.ship.y - 18 })
    shot = 0.18
  }
  const destroyed = new Set<number>()
  bullets = bullets.filter((b) => {
    const hit = enemies.find((e) => !destroyed.has(e.id) && Math.abs(b.x - e.x) < 15 && Math.abs(b.y - e.y) < 16)
    if (!hit) return true
    destroyed.add(hit.id)
    score += 100
    bursts.push({ x: hit.x, y: hit.y, age: 0 })
    return false
  })
  enemies = enemies.filter((e) => {
    if (destroyed.has(e.id)) return false
    const collision = Math.hypot(e.x - state.ship.x, e.y - state.ship.y) < 25
    if (collision || e.y > 420) {
      if (invulnerable <= 0) {
        lives--
        invulnerable = 1.5
      }
      bursts.push({ x: e.x, y: Math.min(400, e.y), age: 0 })
      return false
    }
    return true
  })
  return {
    ...state,
    phase: lives <= 0 ? "over" : "playing",
    lives: Math.max(0, lives),
    enemies,
    bullets: bullets.slice(-48),
    bursts: bursts.slice(-32),
    score,
    time,
    spawn,
    shot,
    sequence,
    invulnerable,
  }
}
