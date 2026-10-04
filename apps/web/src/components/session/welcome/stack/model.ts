import { advanceFixed } from "../timing"

export type Block = { x: number; width: number; perfect: boolean; level: number }
type Cut = { x: number; width: number; level: number; direction: number; age: number }
export type Stack = {
  seed: number
  phase: "ready" | "playing" | "missed"
  ending: number
  blocks: Block[]
  height: number
  camera: number
  remainder: number
  moving: { x: number; width: number; direction: number }
  cooldown: number
  combo: number
  bestCombo: number
  last?: "perfect" | "placed"
  fall?: { block?: Block; cut?: Cut; x: number; width: number; age: number }
  cut?: Cut
}
export const floorHeight = 16
export const stackGround = 308
export const stackCamera = (state: Stack) => Math.max(0, (state.height - 10) * floorHeight)
export function stackLayout(state: Stack, immediate = false) {
  const camera = Math.round(immediate ? stackCamera(state) : state.camera)
  return state.blocks.map((block) => ({
    ...block,
    y: stackGround - (block.level + 1) * floorHeight + camera,
    height: floorHeight,
  }))
}
export function createStack(seed: number): Stack {
  return {
    seed,
    phase: "ready",
    ending: 0,
    blocks: [{ x: 250, width: 220, perfect: false, level: 0 }],
    height: 0,
    camera: 0,
    remainder: 0,
    moving: { x: 250, width: 220, direction: seed % 2 ? -1 : 1 },
    cooldown: 0,
    combo: 0,
    bestCombo: 0,
  }
}
export function dropBlock(state: Stack): Stack {
  if (state.phase === "missed" || state.fall || state.cooldown > 0) return state
  const top = state.blocks.at(-1)!
  const offset = state.moving.x - top.x
  const perfect = Math.abs(offset) <= 7
  const x = perfect ? top.x : Math.max(top.x, state.moving.x)
  const width = perfect ? top.width : Math.min(top.x + top.width, state.moving.x + state.moving.width) - x
  const combo = perfect ? state.combo + 1 : 0
  const restored = combo > 0 && combo % 3 === 0 ? Math.min(220, width + 16) : width
  const block =
    width < 8 ? undefined : { x: x - (restored - width) / 2, width: restored, perfect, level: state.height + 1 }
  const cut = perfect
    ? undefined
    : {
        x: block ? (offset > 0 ? x + width : state.moving.x) : state.moving.x,
        width: block ? state.moving.width - width : state.moving.width,
        level: state.height + 1,
        direction: Math.sign(offset) || 1,
        age: 0,
      }
  return { ...state, phase: "playing", fall: { block, cut, x: state.moving.x, width: state.moving.width, age: 0 } }
}
function tick(state: Stack, dt: number): Stack {
  const cut = state.cut && state.cut.age < 0.8 ? { ...state.cut, age: state.cut.age + dt } : undefined
  const camera = state.camera + (stackCamera(state) - state.camera) * (1 - Math.exp(-18 * dt))
  if (state.fall) {
    const age = state.fall.age + dt
    if (age < 0.14) return { ...state, cut, camera, fall: { ...state.fall, age } }
    const { block } = state.fall
    if (!block) return { ...state, phase: "missed", fall: undefined, cut: state.fall.cut, camera, combo: 0 }
    const combo = block.perfect ? state.combo + 1 : 0
    const direction = -state.moving.direction
    return {
      ...state,
      blocks: [...state.blocks, block].slice(-24),
      height: state.height + 1,
      camera,
      fall: undefined,
      cut: state.fall.cut,
      cooldown: 0.1,
      combo,
      bestCombo: Math.max(combo, state.bestCombo),
      last: block.perfect ? "perfect" : "placed",
      moving: { x: direction > 0 ? 80 : 640 - block.width, width: block.width, direction },
    }
  }
  if (state.phase === "missed") return { ...state, cut, camera, ending: Math.min(1, state.ending + dt) }
  const cooldown = Math.max(0, state.cooldown - dt)
  if (state.cooldown > 0) return { ...state, cut, camera, cooldown }
  const speed = 125 + 475 * (1 - Math.exp(-state.height / 36))
  const x = Math.max(80, Math.min(640 - state.moving.width, state.moving.x + state.moving.direction * speed * dt))
  const direction = x <= 80 ? 1 : x >= 640 - state.moving.width ? -1 : state.moving.direction
  return { ...state, cooldown, cut, camera, moving: { ...state.moving, x, direction } }
}
export function advanceStack(state: Stack, seconds: number): Stack {
  if (state.phase === "missed" && state.ending === 1) return state
  return advanceFixed(state, seconds, tick)
}
