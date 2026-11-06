import { expect, test } from "bun:test"
import {
  createBlocks,
  startBlocks,
  moveBlocks,
  rotateBlocks,
  dropBlocks,
  descendBlocks,
  advanceBlocks,
  controlBlocks,
  blockFallInterval,
  occupiedCells,
  type Blocks,
} from "../../../../src/components/session/welcome/blocks/model"
const run = (state: Blocks, seconds: number, fps = 120) => {
  for (let n = 0; n < Math.round(seconds * fps); n++) state = advanceBlocks(state, 1 / fps)
  return state
}

test("seeded bags are reproducible, hover does not start gravity, and explicit hard drops lock", () => {
  const first = createBlocks(8)
  expect(first).toEqual(createBlocks(8))
  expect(new Set([first.piece.kind, ...first.queue.slice(0, 6)]).size).toBe(7)
  expect(advanceBlocks(moveBlocks(first, 1), 0.1).piece.y).toBe(first.piece.y)
  const dropped = dropBlocks(first)
  expect(dropped.board.filter(Boolean)).toHaveLength(4)
  expect(dropped.phase).toBe("playing")
  expect(dropped.trail?.time).toBeCloseTo(0.09)
  expect(run(dropped, 0.1).trail).toBeUndefined()
})

test("movement respects walls and full rows remain visible for 140 ms before compaction", () => {
  let state = createBlocks(4)
  for (let i = 0; i < 30; i++) state = moveBlocks(state, -1)
  state = rotateBlocks(state)
  expect(occupiedCells(state.piece).every((c) => c.x >= 0 && c.x < 10)).toBe(true)
  const board = Array<number>(200).fill(0)
  for (let x = 0; x < 8; x++) board[190 + x] = 1
  const clearing = dropBlocks({ ...state, board, piece: { kind: 1, rotation: 0, x: 8, y: 0 } })
  expect(clearing.phase).toBe("clearing")
  expect(clearing.board.slice(190).every(Boolean)).toBe(true)
  expect(clearing.lines).toBe(0)
  expect(dropBlocks(clearing)).toBe(clearing)
  const waiting = run(clearing, 0.125)
  expect(waiting.board).toEqual(clearing.board)
  const cleared = run(waiting, 0.025)
  expect(cleared.lines).toBe(1)
  expect(cleared.board.filter(Boolean)).toHaveLength(2)
  expect(cleared.score).toBeGreaterThanOrEqual(100)
  expect(cleared.phase).toBe("playing")
})

test("gravity starts at 420 ms and accelerates every five lines to a 100 ms floor", () => {
  expect(blockFallInterval(0)).toBe(0.42)
  expect(blockFallInterval(4)).toBe(0.42)
  expect(blockFallInterval(5)).toBeCloseTo(0.385)
  expect(blockFallInterval(100)).toBe(0.1)
  const initial = startBlocks(createBlocks(8))
  expect(run(initial, 0.4).piece.y).toBe(0)
  expect(run(initial, 0.425).piece.y).toBe(1)
})

test("held movement is immediate, repeats after 150 ms every 50 ms, and soft drop uses 35 ms", () => {
  const initial = createBlocks(8)
  const pressed = controlBlocks(initial, { horizontal: -1 })
  expect(pressed.piece.x).toBe(2)
  expect(pressed.phase).toBe("playing")
  expect(run(pressed, 0.125).piece.x).toBe(2)
  expect(run(pressed, 0.15).piece.x).toBe(1)
  expect(run(pressed, 0.2).piece.x).toBe(0)
  const released = controlBlocks(pressed, { horizontal: 0 })
  expect(run(released, 0.25).piece.x).toBe(2)
  const soft = controlBlocks(initial, { soft: true })
  expect(soft.piece.y).toBe(1)
  expect(run(soft, 0.2).piece.y).toBe(6)
})

test("ground contact leaves 250 ms to adjust, with eight resets and a two-second total limit", () => {
  const landed = { ...startBlocks(createBlocks(8)), piece: { kind: 1, rotation: 0, x: 4, y: 18 } }
  expect(descendBlocks(landed).board.filter(Boolean)).toHaveLength(0)
  expect(run(landed, 0.24).board.filter(Boolean)).toHaveLength(0)
  expect(run(landed, 0.25).board.filter(Boolean)).toHaveLength(4)
  let adjusted = landed
  for (let n = 0; n < 8; n++) adjusted = moveBlocks(run(adjusted, 0.23), n % 2 ? -1 : 1)
  expect(adjusted.lockResets).toBe(8)
  const last = run(adjusted, 0.1)
  expect(moveBlocks(last, 1).lockTime).toBe(last.lockTime)
  expect(run(adjusted, 0.2).board.filter(Boolean)).toHaveLength(4)
})

test("a blocked spawn ends the round and restart is clean", () => {
  const initial = createBlocks(3),
    board = Array<number>(200).fill(1)
  board.fill(0, 190)
  const ended = dropBlocks({ ...initial, phase: "playing", board, piece: { kind: 1, rotation: 0, x: 0, y: 18 } })
  expect(ended.phase).toBe("over")
  expect(moveBlocks(ended, 1)).toBe(ended)
  expect(createBlocks(3).board.filter(Boolean)).toHaveLength(0)
})

test("fixed gravity and repeats give identical results at 30, 60 and 120 Hz", () => {
  const simulate = (fps: number) => run(controlBlocks(createBlocks(8), { horizontal: -1, soft: true }), 5, fps)
  expect(simulate(30)).toEqual(simulate(120))
  expect(simulate(60)).toEqual(simulate(120))
})
