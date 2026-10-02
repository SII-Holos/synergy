import { expect, test } from "bun:test"
import {
  createIsland,
  placeRoad,
  rotateRoad,
  islandRoute,
  advanceCar,
} from "../../../../src/components/session/welcome/island/model"

function connected() {
  let state = createIsland()
  state = placeRoad(state, 2, 2, "road")
  state = placeRoad(state, 3, 2, "bridge")
  return placeRoad(state, 4, 2, "road")
}

test("the car waits for a connected route, then reaches the observatory", () => {
  const initial = createIsland()
  expect(islandRoute(initial)).toEqual([])
  expect(advanceCar(initial, 100).progress).toBe(0)
  const state = connected()
  expect(islandRoute(state).map(({ x }) => x)).toEqual([0, 1, 2, 3, 4, 5, 6])
  expect(advanceCar(state, 100).progress).toBe(6)
})

test("rivers require bridges, matching exits matter, and editing resets the drive", () => {
  expect(placeRoad(createIsland(), 3, 2, "road")).toEqual(createIsland())
  expect(placeRoad(createIsland(), -1, 2, "road")).toEqual(createIsland())
  expect(placeRoad(createIsland(), 2, 2, "bridge")).toEqual(createIsland())
  const driving = advanceCar(connected(), 2)
  expect(driving.progress).toBeGreaterThan(0)
  const turned = rotateRoad(driving, 2, 2)
  expect(turned.progress).toBe(0)
  expect(islandRoute(turned)).toEqual([])
  expect(islandRoute(rotateRoad(turned, 2, 2))).toHaveLength(7)
})
