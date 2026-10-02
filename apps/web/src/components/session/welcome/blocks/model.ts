import { sceneRandom } from "../random"
import { advanceFixed } from "../timing"

export type Piece = { kind: number; rotation: number; x: number; y: number }
export type BlockControls = { horizontal: number; soft: boolean }
export type Blocks = {
  seed: number
  bag: number
  board: number[]
  queue: number[]
  piece: Piece
  phase: "ready" | "playing" | "clearing" | "over"
  score: number
  lines: number
  elapsed: number
  remainder: number
  cleared: number[]
  flash: number
  lockTime: number
  groundAge: number
  lockResets: number
  touched: boolean
  controls: BlockControls
  repeat: number
  softTime: number
  trail?: { piece: Piece; to: number; time: number }
}
const shapes = [
  [
    [0, 1],
    [1, 1],
    [2, 1],
    [3, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [0, 1],
    [1, 1],
  ],
  [
    [1, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  [
    [1, 0],
    [2, 0],
    [0, 1],
    [1, 1],
  ],
  [
    [0, 0],
    [1, 0],
    [1, 1],
    [2, 1],
  ],
  [
    [0, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
  [
    [2, 0],
    [0, 1],
    [1, 1],
    [2, 1],
  ],
]
function bag(seed: number, index: number) {
  const random = sceneRandom(seed + index * 7919)
  const pieces = [0, 1, 2, 3, 4, 5, 6]
  for (let i = pieces.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[pieces[i], pieces[j]] = [pieces[j]!, pieces[i]!]
  }
  return pieces
}
export function occupiedCells(piece: Piece) {
  const size = piece.kind === 0 ? 4 : piece.kind === 1 ? 2 : 3
  return shapes[piece.kind]!.map(([sx, sy]) => {
    let x = sx!,
      y = sy!
    for (let i = 0; i < piece.rotation; i++) [x, y] = [size - 1 - y, x]
    return { x: x + piece.x, y: y + piece.y }
  })
}
function fits(board: number[], piece: Piece) {
  return occupiedCells(piece).every(({ x, y }) => x >= 0 && x < 10 && y < 20 && (y < 0 || !board[y * 10 + x]))
}

export function createBlocks(seed: number): Blocks {
  const queue = [...bag(seed, 0), ...bag(seed, 1)]
  return {
    seed,
    bag: 2,
    board: Array<number>(200).fill(0),
    queue: queue.slice(1),
    piece: { kind: queue[0]!, rotation: 0, x: 3, y: 0 },
    phase: "ready",
    score: 0,
    lines: 0,
    elapsed: 0,
    remainder: 0,
    cleared: [],
    flash: 0,
    lockTime: 0,
    groundAge: 0,
    lockResets: 0,
    touched: false,
    controls: { horizontal: 0, soft: false },
    repeat: 0,
    softTime: 0,
  }
}
export function startBlocks(state: Blocks): Blocks {
  return state.phase === "ready" ? { ...state, phase: "playing" } : state
}
export const blockFallInterval = (lines: number) => Math.max(0.1, 0.42 - Math.floor(lines / 5) * 0.035)
const editable = (state: Blocks) => state.phase === "ready" || state.phase === "playing"
const grounded = (state: Blocks) => !fits(state.board, { ...state.piece, y: state.piece.y + 1 })
function adjusted(state: Blocks, piece: Piece): Blocks {
  const reset = (state.touched || grounded(state)) && state.lockResets < 8 && state.groundAge < 2
  return { ...state, piece, lockTime: reset ? 0 : state.lockTime, lockResets: state.lockResets + (reset ? 1 : 0) }
}
export function moveBlocks(state: Blocks, dx: number): Blocks {
  if (!editable(state) || !dx) return state
  const piece = { ...state.piece, x: state.piece.x + Math.sign(dx) }
  return fits(state.board, piece) ? adjusted(state, piece) : state
}
export function rotateBlocks(state: Blocks): Blocks {
  if (!editable(state)) return state
  for (const dx of [0, -1, 1, -2, 2]) {
    const piece = { ...state.piece, rotation: (state.piece.rotation + 1) % 4, x: state.piece.x + dx }
    if (fits(state.board, piece)) return adjusted(state, piece)
  }
  return state
}
export function landingPiece(state: Blocks) {
  let piece = state.piece
  while (fits(state.board, { ...piece, y: piece.y + 1 })) piece = { ...piece, y: piece.y + 1 }
  return piece
}
function spawn(state: Blocks): Blocks {
  const queue = [...state.queue]
  let nextBag = state.bag
  if (queue.length < 7) queue.push(...bag(state.seed, nextBag++))
  const piece = { kind: queue.shift()!, rotation: 0, x: 3, y: 0 }
  return {
    ...state,
    piece,
    queue,
    bag: nextBag,
    elapsed: 0,
    lockTime: 0,
    groundAge: 0,
    lockResets: 0,
    touched: false,
    cleared: [],
    flash: 0,
    phase: fits(state.board, piece) ? "playing" : "over",
  }
}
function lock(state: Blocks): Blocks {
  const cells = occupiedCells(state.piece)
  if (!fits(state.board, state.piece) || cells.some((c) => c.y < 0)) return { ...state, phase: "over" }
  const board = [...state.board]
  for (const { x, y } of cells) board[y * 10 + x] = state.piece.kind + 1
  const cleared = Array.from({ length: 20 }, (_, y) => y).filter((y) => board.slice(y * 10, y * 10 + 10).every(Boolean))
  const next = { ...state, board, cleared }
  return cleared.length ? { ...next, phase: "clearing", flash: 0.14 } : spawn(next)
}
export function dropBlocks(state: Blocks): Blocks {
  if (!editable(state)) return state
  const piece = landingPiece(state)
  return lock({
    ...state,
    piece,
    score: state.score + (piece.y - state.piece.y) * 2,
    trail: { piece: state.piece, to: piece.y, time: 0.09 },
  })
}
function fall(state: Blocks): Blocks {
  const piece = { ...state.piece, y: state.piece.y + 1 }
  return fits(state.board, piece) ? { ...state, piece } : state
}
export function descendBlocks(state: Blocks): Blocks {
  return editable(state) ? fall({ ...startBlocks(state), elapsed: 0 }) : state
}
export function controlBlocks(state: Blocks, change: Partial<BlockControls>): Blocks {
  const controls = { ...state.controls, ...change }
  if (controls.horizontal === state.controls.horizontal && controls.soft === state.controls.soft) return state
  let next = { ...state, controls }
  if (controls.horizontal !== state.controls.horizontal) {
    next.repeat = controls.horizontal ? 0.15 : 0
    if (controls.horizontal) next = moveBlocks(startBlocks(next), controls.horizontal)
  }
  if (controls.soft !== state.controls.soft) {
    next.softTime = 0
    if (controls.soft) next = descendBlocks(next)
  }
  return next
}
function tick(state: Blocks, dt: number): Blocks {
  let next: Blocks = {
    ...state,
    trail: state.trail && state.trail.time > dt ? { ...state.trail, time: state.trail.time - dt } : undefined,
  }
  if (next.phase === "over") return next
  if (next.phase === "clearing") {
    next.flash = Math.max(0, next.flash - dt)
    if (next.flash > 1e-9) return next
    const count = next.cleared.length
    const board = [
      ...Array<number>(count * 10).fill(0),
      ...next.board.filter((_, index) => !next.cleared.includes(Math.floor(index / 10))),
    ]
    return spawn({
      ...next,
      board,
      lines: next.lines + count,
      score: next.score + [0, 100, 300, 500, 800][count]! * (1 + Math.floor(next.lines / 10)),
    })
  }
  if (next.controls.horizontal) {
    next.repeat -= dt
    if (next.repeat < 1e-9) {
      next = moveBlocks(next, next.controls.horizontal)
      next = { ...next, repeat: next.repeat + 0.05 }
    }
  }
  if (next.controls.soft) {
    next.softTime += dt
    if (next.softTime + 1e-9 >= 0.035) next = { ...fall(next), softTime: next.softTime - 0.035, elapsed: 0 }
  } else {
    next.elapsed += dt
    const interval = blockFallInterval(next.lines)
    if (next.elapsed + 1e-9 >= interval) next = { ...fall(next), elapsed: Math.max(0, next.elapsed - interval) }
  }
  const contact = grounded(next)
  next.touched ||= contact
  if (next.touched) next.groundAge += dt
  next.lockTime = contact ? next.lockTime + dt : 0
  return contact && (next.lockTime + 1e-9 >= 0.25 || next.groundAge + 1e-9 >= 2) ? lock(next) : next
}
export function advanceBlocks(state: Blocks, seconds: number): Blocks {
  return state.phase === "ready" ? state : advanceFixed(state, seconds, tick)
}
