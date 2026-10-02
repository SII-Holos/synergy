export type Point = { x: number; y: number }
export type Planet = Point & { radius: number; gravity: number }
export type Orbit = {
  seed: number
  round: number
  phase: "aiming" | "flying" | "delivered" | "missed"
  angle: number
  power: number
  shots: number
  elapsed: number
  remainder: number
  planets: Planet[]
  target: Point
  ship: Point & { vx: number; vy: number }
  trace: Point[]
}
export const launchPoint = { x: 92, y: 240 }
const step = 1 / 120

export function createOrbit(seed: number, round = 0): Orbit {
  const layouts = [
    {
      angle: -12.5,
      target: { x: 620, y: 140 },
      planets: [
        { x: 310, y: 238, radius: 32, gravity: 110000 },
        { x: 480, y: 48, radius: 22, gravity: 40000 },
      ],
    },
    {
      angle: -9,
      target: { x: 620, y: 175 },
      planets: [
        { x: 310, y: 268, radius: 32, gravity: 120000 },
        { x: 480, y: 90, radius: 26, gravity: 60000 },
      ],
    },
    {
      angle: -17,
      target: { x: 620, y: 90 },
      planets: [
        { x: 300, y: 262, radius: 32, gravity: 100000 },
        { x: 470, y: 200, radius: 26, gravity: 65000 },
      ],
    },
  ]
  const layout = layouts[round]!
  return {
    seed,
    round,
    phase: "aiming",
    ...layout,
    power: 340,
    shots: 0,
    elapsed: 0,
    remainder: 0,
    ship: { ...launchPoint, vx: 0, vy: 0 },
    trace: [],
  }
}

export function aimOrbit(state: Orbit, angle: number, power: number): Orbit {
  if (state.phase !== "aiming" || !Number.isFinite(angle + power)) return state
  return { ...state, angle: Math.max(-75, Math.min(10, angle)), power: Math.max(220, Math.min(440, power)) }
}

export function launchOrbit(state: Orbit): Orbit {
  if (state.phase !== "aiming") return state
  const radians = (state.angle * Math.PI) / 180
  return {
    ...state,
    phase: "flying",
    shots: state.shots + 1,
    elapsed: 0,
    remainder: 0,
    trace: [],
    ship: { ...launchPoint, vx: Math.cos(radians) * state.power, vy: Math.sin(radians) * state.power },
  }
}

export function advanceOrbit(state: Orbit, seconds: number): Orbit {
  if (state.phase !== "flying" || seconds <= 0) return state
  let remainder = state.remainder + Math.min(seconds, 1)
  let elapsed = state.elapsed
  let phase: Orbit["phase"] = state.phase
  let ship = { ...state.ship }
  const trace = [...state.trace]
  while (remainder >= step && phase === "flying") {
    remainder -= step
    elapsed += step
    for (const planet of state.planets) {
      const dx = planet.x - ship.x,
        dy = planet.y - ship.y
      const distance = Math.max(planet.radius, Math.hypot(dx, dy))
      ship.vx += (((dx / distance) * planet.gravity) / (distance * distance)) * step
      ship.vy += (((dy / distance) * planet.gravity) / (distance * distance)) * step
    }
    ship = { ...ship, x: ship.x + ship.vx * step, y: ship.y + ship.vy * step }
    if (Math.hypot(ship.x - state.target.x, ship.y - state.target.y) < 25) phase = "delivered"
    else if (
      ship.x < 10 ||
      ship.x > 710 ||
      ship.y < 8 ||
      ship.y > 305 ||
      elapsed > 6 ||
      state.planets.some((p) => Math.hypot(p.x - ship.x, p.y - ship.y) < p.radius + 5)
    )
      phase = "missed"
    if (trace.length === 0 || Math.hypot(ship.x - trace.at(-1)!.x, ship.y - trace.at(-1)!.y) > 7)
      trace.push({ x: ship.x, y: ship.y })
  }
  return { ...state, phase, ship, elapsed, remainder, trace: trace.slice(-80) }
}

export function predictOrbit(state: Orbit): Point[] {
  let future = launchOrbit(state)
  if (future === state) return []
  for (let i = 0; i < 24 && future.phase === "flying"; i++) future = advanceOrbit(future, 0.05)
  return future.trace
}

export function prepareOrbit(state: Orbit): Orbit {
  if (state.phase === "delivered") return createOrbit(state.seed, (state.round + 1) % 3)
  if (state.phase !== "missed") return state
  if (state.shots >= 3) return createOrbit(state.seed, state.round)
  return { ...state, phase: "aiming", ship: { ...launchPoint, vx: 0, vy: 0 }, trace: [], elapsed: 0, remainder: 0 }
}
