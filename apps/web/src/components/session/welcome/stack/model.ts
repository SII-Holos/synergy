export type Block = { x: number; width: number; perfect: boolean }
export type Stack = {
  seed: number
  phase: "ready" | "playing" | "won" | "missed"
  blocks: Block[]
  moving: { x: number; width: number; direction: number }
  cooldown: number
  combo: number
  bestCombo: number
  last?: "perfect" | "placed"
  cut?: { x: number; width: number; level: number; direction: number; age: number }
}
export const stackGoal = 12

export function createStack(seed: number): Stack {
  return {
    seed,
    phase: "ready",
    blocks: [{ x: 250, width: 220, perfect: false }],
    moving: { x: 250, width: 220, direction: seed % 2 ? -1 : 1 },
    cooldown: 0,
    combo: 0,
    bestCombo: 0,
  }
}

export function dropBlock(state: Stack): Stack {
  if (state.phase === "won" || state.phase === "missed" || state.cooldown > 0) return state
  const top = state.blocks.at(-1)!
  const offset = state.moving.x - top.x
  const perfect = Math.abs(offset) <= 7
  const x = perfect ? top.x : Math.max(top.x, state.moving.x)
  const width = perfect ? top.width : Math.min(top.x + top.width, state.moving.x + state.moving.width) - x
  if (width < 8) return { ...state, phase: "missed", combo: 0 }
  const combo = perfect ? state.combo + 1 : 0
  const restored = combo > 0 && combo % 3 === 0 ? Math.min(220, width + 16) : width
  const block = { x: x - (restored - width) / 2, width: restored, perfect }
  const blocks = [...state.blocks, block]
  const direction = -state.moving.direction
  return {
    ...state,
    blocks,
    combo,
    bestCombo: Math.max(combo, state.bestCombo),
    phase: blocks.length > stackGoal ? "won" : "playing",
    cooldown: 0.22,
    last: perfect ? "perfect" : "placed",
    moving: { x: direction > 0 ? 80 : 640 - restored, width: restored, direction },
    cut: perfect
      ? undefined
      : {
          x: offset > 0 ? x + width : state.moving.x,
          width: state.moving.width - width,
          level: blocks.length - 1,
          direction: Math.sign(offset),
          age: 0,
        },
  }
}

export function advanceStack(state: Stack, seconds: number): Stack {
  if (seconds <= 0 || !Number.isFinite(seconds)) return state
  const dt = Math.min(seconds, 0.05)
  const cut = state.cut && state.cut.age < 0.8 ? { ...state.cut, age: state.cut.age + dt } : undefined
  if (state.phase !== "playing" && state.phase !== "ready") return cut === state.cut ? state : { ...state, cut }
  const speed = 105 + (state.blocks.length - 2) * 12
  const x = Math.max(80, Math.min(640 - state.moving.width, state.moving.x + state.moving.direction * speed * dt))
  const direction = x <= 80 ? 1 : x >= 640 - state.moving.width ? -1 : state.moving.direction
  return { ...state, cooldown: Math.max(0, state.cooldown - dt), cut, moving: { ...state.moving, x, direction } }
}
