import { expect, test } from "bun:test"
import {
  createBlocks,
  moveBlocks,
  rotateBlocks,
  dropBlocks,
  advanceBlocks,
  occupiedCells,
} from "../../../../src/components/session/welcome/blocks/model"

test("seeded seven-piece bags remain reproducible and hard drops lock above the floor", () => {
  expect(createBlocks(8)).toEqual(createBlocks(8))
  const first = createBlocks(8)
  expect(new Set([first.piece.kind, ...first.queue.slice(0, 6)]).size).toBe(7)
  expect(advanceBlocks(first, 1)).toBe(first)
  const dropped = dropBlocks(first)
  expect(dropped.board.filter(Boolean)).toHaveLength(4)
  expect(dropped.phase).toBe("playing")
  expect(first.board.every((cell) => !cell)).toBe(true)
})

test("movement and rotation respect walls, locked cells, and complete rows clear together", () => {
  let state = createBlocks(4)
  for (let i = 0; i < 30; i++) state = moveBlocks(state, -1)
  state = rotateBlocks(state)
  expect(occupiedCells(state.piece).every((cell) => cell.x >= 0 && cell.x < 10)).toBe(true)
  const board = Array<number>(200).fill(0)
  for (let x = 0; x < 8; x++) board[190 + x] = 1
  const cleared = dropBlocks({ ...state, board, piece: { kind: 1, rotation: 0, x: 8, y: 0 } })
  expect(cleared.lines).toBe(1)
  expect(cleared.board.filter(Boolean)).toHaveLength(2)
  expect(cleared.score).toBeGreaterThanOrEqual(100)
})

test("a blocked spawn ends the round and restart is clean", () => {
  const initial = createBlocks(3)
  const board = Array<number>(200).fill(1)
  board.fill(0, 190)
  const ended = dropBlocks({ ...initial, phase: "playing", board, piece: { kind: 1, rotation: 0, x: 0, y: 18 } })
  expect(ended.phase).toBe("over")
  expect(moveBlocks(ended, 1)).toBe(ended)
  expect(createBlocks(3).board.filter(Boolean)).toHaveLength(0)
})
