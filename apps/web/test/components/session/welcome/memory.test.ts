import { expect, test } from "bun:test"
import { createWelcomeMemory } from "../../../../src/components/session/welcome/types"

test("scene remounts reuse the last snapshot without initializing or sharing another experience", () => {
  const memory = createWelcomeMemory()
  let initializations = 0
  const initialize = () => ({ score: ++initializations, position: { x: 3, y: 4 } })
  const first = memory.read(initialize)
  expect(memory.read(initialize)).toBe(first)
  expect(initializations).toBe(1)
  const snapshot = { score: 10, position: { x: 20, y: 30 } }
  memory.write(snapshot)
  expect(memory.read(initialize)).toBe(snapshot)
  expect(initializations).toBe(1)
  expect(createWelcomeMemory().read(initialize)).toEqual({ score: 2, position: { x: 3, y: 4 } })
  expect(memory.read(initialize)).toBe(snapshot)
})
