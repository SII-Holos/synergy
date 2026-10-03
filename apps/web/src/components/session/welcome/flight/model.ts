import { sceneRandom } from "../random"
import { advanceFixed } from "../timing"

type Point = { x: number; y: number }
export type PickupKind = "fire" | "shield" | "repair"
export type Flight = {
  seed: number
  phase: "ready" | "playing" | "over"
  ending: number
  ship: Point
  enemies: (Point & { id: number; origin: number; age: number; kind: number; hp: number; flash: number })[]
  bullets: (Point & { vx: number })[]
  pickups: (Point & { id: number; kind: PickupKind })[]
  bursts: (Point & { age: number; kind: "hit" | "destroy" | "hurt" | "pickup" | "shield"; points: number })[]
  notice?: { kind: PickupKind; points: number; age: number }
  lives: number
  score: number
  kills: number
  combo: number
  time: number
  spawn: number
  shot: number
  sequence: number
  invulnerable: number
  fire: number
  shield: number
  muzzle: number
  remainder: number
}
export function createFlight(seed: number): Flight {
  return {
    seed,
    phase: "ready",
    ending: 0,
    ship: { x: 360, y: 330 },
    enemies: [],
    bullets: [],
    pickups: [],
    bursts: [],
    lives: 3,
    score: 0,
    kills: 0,
    combo: 0,
    time: 0,
    spawn: 0.1,
    shot: 0,
    sequence: 0,
    invulnerable: 0,
    fire: 0,
    shield: 0,
    muzzle: 0,
    remainder: 0,
  }
}
export function aimFlight(state: Flight, x: number, y: number): Flight {
  if (state.phase === "over" || !Number.isFinite(x + y)) return state
  return { ...state, ship: { x: Math.max(20, Math.min(700, x)), y: Math.max(100, Math.min(380, y)) } }
}
export function startFlight(state: Flight): Flight {
  return state.phase === "ready" ? { ...state, phase: "playing" } : state
}
function tick(state: Flight, dt: number, direction: Point): Flight {
  const bursts = state.bursts.map((b) => ({ ...b, age: b.age + dt })).filter((b) => b.age < 0.6)
  let notice = state.notice && state.notice.age + dt < 1.4 ? { ...state.notice, age: state.notice.age + dt } : undefined
  if (state.phase === "over") {
    const ending = Math.min(1, state.ending + dt)
    const coast = (Math.exp(-4 * state.ending) - Math.exp(-4 * ending)) / 4
    return {
      ...state,
      ending,
      enemies: ending === 1 ? [] : state.enemies.map((e) => ({ ...e, y: e.y + 90 * coast, flash: 0 })),
      bullets: ending === 1 ? [] : state.bullets.map((b) => ({ ...b, x: b.x + b.vx * coast, y: b.y - 440 * coast })),
      pickups: ending === 1 ? [] : state.pickups.map((p) => ({ ...p, y: p.y + 42 * coast })),
      bursts,
      notice: undefined,
      muzzle: 0,
    }
  }
  const ship = aimFlight(state, state.ship.x + direction.x * 290 * dt, state.ship.y + direction.y * 290 * dt).ship
  const time = state.time + dt
  let score = state.score,
    kills = state.kills,
    combo = state.combo,
    lives = state.lives
  let invulnerable = Math.max(0, state.invulnerable - dt),
    fire = Math.max(0, state.fire - dt),
    shield = Math.max(0, state.shield - dt)
  let spawn = state.spawn - dt,
    shot = state.shot - dt,
    sequence = state.sequence,
    muzzle = Math.max(0, state.muzzle - dt)
  let enemies = state.enemies.map((e) => {
    const age = e.age + dt
    const speed = (48 + Math.min(65, time * 0.65)) * (e.kind === 2 ? 0.65 : e.kind === 1 ? 1.15 : 1)
    return {
      ...e,
      age,
      y: e.y + speed * dt,
      x: e.kind === 1 ? Math.max(20, Math.min(700, e.origin + Math.sin(age * 2.2) * 48)) : e.x,
      flash: Math.max(0, e.flash - dt),
    }
  })
  let bullets = state.bullets
    .map((b) => ({ ...b, x: b.x + b.vx * dt, y: b.y - 440 * dt }))
    .filter((b) => b.y > -15 && b.x > -10 && b.x < 730)
  let pickups = state.pickups.map((p) => ({ ...p, y: p.y + 42 * dt })).filter((p) => p.y < 420)
  pickups = pickups.filter((p) => {
    if (Math.hypot(p.x - ship.x, p.y - ship.y) > 27) return true
    const points = p.kind === "repair" && lives === 3 ? 150 : 0
    if (p.kind === "fire") fire = 10
    else if (p.kind === "shield") shield = 8
    else if (lives < 3) lives++
    else score += 150
    bursts.push({ ...p, age: 0, kind: "pickup", points: 0 })
    notice = { kind: p.kind, points, age: 0 }
    return false
  })
  if (spawn <= 0) {
    if (enemies.length < 24) {
      const random = sceneRandom(state.seed + sequence * 7919)
      const x = 40 + random() * 640,
        kind = Math.floor(random() * 3)
      enemies.push({
        id: sequence++,
        x,
        origin: x,
        y: -20,
        age: 0,
        kind,
        hp: kind === 2 ? 3 : kind === 1 ? 2 : 1,
        flash: 0,
      })
    }
    spawn += Math.max(0.28, 0.85 - time / 160)
  }
  if (shot <= 0) {
    if (fire > 0) for (const vx of [-140, 0, 140]) bullets.push({ x: ship.x, y: ship.y - 18, vx })
    else for (const dx of [-6, 6]) bullets.push({ x: ship.x + dx, y: ship.y - 18, vx: 0 })
    shot += fire > 0 ? 0.105 : 0.22
    muzzle = 0.055
  }
  const destroyed = new Set<number>()
  bullets = bullets.filter((b) => {
    const hit = enemies.find(
      (e) => !destroyed.has(e.id) && Math.abs(b.x - e.x) < (e.kind === 2 ? 21 : 15) && Math.abs(b.y - e.y) < 16,
    )
    if (!hit) return true
    hit.hp--
    hit.flash = 0.09
    if (hit.hp > 0) {
      bursts.push({ x: b.x, y: b.y, age: 0, kind: "hit", points: 0 })
      return false
    }
    destroyed.add(hit.id)
    kills++
    combo++
    const points = 100 + Math.min(100, Math.floor(combo / 5) * 25)
    score += points
    bursts.push({ x: hit.x, y: hit.y, age: 0, kind: "destroy", points })
    const kind =
      kills === 3
        ? "fire"
        : kills >= 9 && (kills - 9) % 6 === 0
          ? (["shield", "fire", "repair"] as const)[((kills - 9) / 6) % 3]
          : undefined
    if (kind) pickups.push({ id: sequence++, x: hit.x, y: hit.y, kind })
    return false
  })
  enemies = enemies.filter((e) => {
    if (destroyed.has(e.id)) return false
    if (e.y > 420) {
      combo = 0
      return false
    }
    if (Math.hypot(e.x - ship.x, e.y - ship.y) >= (e.kind === 2 ? 30 : 25)) return true
    if (invulnerable <= 0) {
      const protectedHit = shield > 0
      if (protectedHit) shield = 0
      else lives--
      combo = 0
      invulnerable = 1.5
      bursts.push({ ...ship, age: 0, kind: protectedHit ? "shield" : "hurt", points: 0 })
    }
    return false
  })
  return {
    ...state,
    ship,
    phase: lives <= 0 ? "over" : "playing",
    lives: Math.max(0, lives),
    enemies,
    bullets: bullets.slice(-64),
    pickups: pickups.slice(-8),
    bursts: bursts.slice(-32),
    notice,
    score,
    kills,
    combo,
    time,
    spawn,
    shot,
    sequence,
    invulnerable,
    fire,
    shield,
    muzzle,
  }
}
export function advanceFlight(state: Flight, seconds: number, direction: Point = { x: 0, y: 0 }): Flight {
  if (state.phase === "ready" || (state.phase === "over" && state.ending === 1)) return state
  return advanceFixed(state, seconds, (s, dt) => tick(s, dt, direction))
}
