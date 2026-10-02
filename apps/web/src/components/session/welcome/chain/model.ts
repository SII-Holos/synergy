import { sceneRandom } from "../random"

export type Star = { x: number; y: number; vx: number; vy: number; kind: number; litAt: number | null }
export type Chain = {
  seed: number
  round: number
  phase: "ready" | "burst" | "won" | "missed"
  time: number
  stars: Star[]
  origin?: { x: number; y: number }
}

export const chainTargets = [12, 18, 24] as const
export const chainHits = (state: Chain) => state.stars.filter((s) => s.litAt !== null).length
export function burstRadius(age: number, kind = 0) {
  if (age < 0 || age >= 1.6) return 0
  return (70 + kind * 10) * Math.min(1, age / 0.28, (1.6 - age) / 0.45)
}

export function createChain(seed: number, round = 0): Chain {
  const random = sceneRandom(seed + round * 7919)
  return {
    seed,
    round,
    phase: "ready",
    time: 0,
    stars: Array.from({ length: 36 }, (_, i) => ({
      x: 80 + (i % 9) * 70 + (random() - 0.5) * 48,
      y: 52 + Math.floor(i / 9) * 60 + (random() - 0.5) * 36,
      vx: (random() - 0.5) * 22,
      vy: (random() - 0.5) * 18,
      kind: i % 3,
      litAt: null,
    })),
  }
}

export function igniteChain(state: Chain, x: number, y: number): Chain {
  if (state.phase !== "ready" || !Number.isFinite(x + y)) return state
  return {
    ...state,
    phase: "burst",
    time: 0,
    origin: { x: Math.max(0, Math.min(720, x)), y: Math.max(0, Math.min(300, y)) },
  }
}

export function advanceChain(state: Chain, seconds: number): Chain {
  if (state.phase === "won" || state.phase === "missed" || seconds <= 0) return state
  const dt = Math.min(seconds, 0.05)
  const time = state.time + dt
  const waves = state.stars.flatMap((s) =>
    s.litAt === null ? [] : [{ ...s, radius: burstRadius(time - s.litAt, s.kind) }],
  )
  if (state.origin) waves.push({ ...state.origin, vx: 0, vy: 0, kind: 2, litAt: 0, radius: burstRadius(time, 2) })
  const stars = state.stars.map((star) => {
    if (star.litAt !== null) return star
    const x = Math.max(28, Math.min(692, star.x + star.vx * dt))
    const y = Math.max(28, Math.min(272, star.y + star.vy * dt))
    return {
      ...star,
      x,
      y,
      vx: x === 28 || x === 692 ? -star.vx : star.vx,
      vy: y === 28 || y === 272 ? -star.vy : star.vy,
      litAt: waves.some((w) => w.radius > 0 && Math.hypot(w.x - x, w.y - y) <= w.radius + 5) ? time : null,
    }
  })
  const next = { ...state, time, stars }
  if (state.phase === "burst" && time > 1.6 && stars.every((s) => s.litAt === null || time - s.litAt >= 1.6)) {
    next.phase = chainHits(next) >= chainTargets[state.round]! ? "won" : "missed"
  }
  return next
}

export function nextChain(state: Chain): Chain {
  return createChain(state.seed, state.phase === "won" ? (state.round + 1) % chainTargets.length : state.round)
}
