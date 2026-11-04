import { expect, test } from "bun:test"
import { ResourceCosts } from "../../src/resources/costs"

test("learns isolated worker costs in bounded size cohorts without charging idle RSS twice", () => {
  const costs = new ResourceCosts()
  const small = costs.turn(100)
  costs.observeStartup(512 * 1024 ** 2)
  costs.observeTurn(32 * 1024 ** 2, 1024 ** 3)
  expect(costs.startup()).toBe(640 * 1024 ** 2)
  expect(costs.turn(100)).toBe(small)
  expect(costs.turn(32 * 1024 ** 2)).toBeGreaterThan(1024 ** 3)
  for (let index = 0; index < 64; index++) costs.observeTurn(32 * 1024 ** 2, 0)
  expect(costs.turn(32 * 1024 ** 2)).toBe(160 * 1024 ** 2)
})
