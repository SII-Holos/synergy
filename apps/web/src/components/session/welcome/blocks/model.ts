import { sceneRandom } from "../random"

export type Piece = { kind: number; rotation: number; x: number; y: number }
export type Blocks = {
  seed: number
  bag: number
  board: number[]
  queue: number[]
  piece: Piece
  phase: "ready" | "playing" | "over"
  score: number
  lines: number
  elapsed: number
  cleared: number[]
  flash: number
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
    cleared: [],
    flash: 0,
  }
}
export function moveBlocks(state: Blocks, dx: number): Blocks {
  if (state.phase === "over") return state
  const piece = { ...state.piece, x: state.piece.x + Math.sign(dx) }
  return fits(state.board, piece) ? { ...state, piece } : state
}
export function rotateBlocks(state: Blocks): Blocks {
  if (state.phase === "over") return state
  for (const dx of [0, -1, 1, -2, 2]) {
    const piece = { ...state.piece, rotation: (state.piece.rotation + 1) % 4, x: state.piece.x + dx }
    if (fits(state.board, piece)) return { ...state, piece }
  }
  return state
}
export function landingPiece(state: Blocks) {
  let piece = state.piece
  while (fits(state.board, { ...piece, y: piece.y + 1 })) piece = { ...piece, y: piece.y + 1 }
  return piece
}
function lock(state: Blocks): Blocks {
  const cells = occupiedCells(state.piece)
  if (!fits(state.board, state.piece) || cells.some((c) => c.y < 0)) return { ...state, phase: "over" }
  const board = [...state.board]
  for (const { x, y } of cells) board[y * 10 + x] = state.piece.kind + 1
  const rows = Array.from({ length: 20 }, (_, y) => board.slice(y * 10, y * 10 + 10))
  const cleared = rows.flatMap((row, y) => (row.every(Boolean) ? [y] : []))
  const remaining = rows.filter((_, y) => !cleared.includes(y)).flat()
  const nextBoard = [...Array<number>(cleared.length * 10).fill(0), ...remaining]
  const queue = [...state.queue]
  let nextBag = state.bag
  if (queue.length < 7) queue.push(...bag(state.seed, nextBag++))
  const piece = { kind: queue.shift()!, rotation: 0, x: 3, y: 0 }
  return {
    ...state,
    board: nextBoard,
    piece,
    queue,
    bag: nextBag,
    elapsed: 0,
    cleared,
    flash: cleared.length ? 0.3 : 0,
    lines: state.lines + cleared.length,
    score: state.score + [0, 100, 300, 500, 800][cleared.length]! * (1 + Math.floor(state.lines / 10)),
    phase: fits(nextBoard, piece) ? "playing" : "over",
  }
}
export function dropBlocks(state: Blocks): Blocks {
  if (state.phase === "over") return state
  const piece = landingPiece(state)
  return lock({ ...state, piece, score: state.score + (piece.y - state.piece.y) * 2 })
}
export function descendBlocks(state: Blocks): Blocks {
  if (state.phase === "over") return state
  const piece = { ...state.piece, y: state.piece.y + 1 }
  return fits(state.board, piece) ? { ...state, piece, phase: "playing", elapsed: 0 } : lock(state)
}
export function advanceBlocks(state: Blocks, seconds: number): Blocks {
  if (state.phase !== "playing" || seconds <= 0 || !Number.isFinite(seconds)) return state
  const elapsed = state.elapsed + Math.min(seconds, 0.1)
  const next = { ...state, elapsed, flash: Math.max(0, state.flash - seconds) }
  return elapsed >= Math.max(0.12, 0.75 - Math.floor(state.lines / 10) * 0.08) ? descendBlocks(next) : next
}
