import { expect, test } from "bun:test"
import { stayedInBackground, type Oracle } from "../../script/computer-fixture"

const initial: Oracle = {
  pid: 42,
  command: "",
  frontmost: 7,
  frontmostHistory: [7],
  activationCount: 0,
  spaceChangeCount: 0,
  windows: [],
  displays: [],
}

test("background acceptance rejects transient activation even after foreground is restored", () => {
  expect(stayedInBackground(initial, { ...initial, frontmostHistory: [7, 42, 7] })).toBe(false)
  expect(stayedInBackground(initial, { ...initial, activationCount: 1 })).toBe(false)
  expect(stayedInBackground(initial, { ...initial, spaceChangeCount: 2 })).toBe(false)
  expect(stayedInBackground(initial, { ...initial, frontmost: 42 })).toBe(false)
})

test("background acceptance requires an inactive target and an uninterrupted foreground", () => {
  expect(stayedInBackground(initial, initial)).toBe(true)
  expect(stayedInBackground({ ...initial, frontmost: 42 }, initial)).toBe(false)
  expect(stayedInBackground(initial, { ...initial, frontmostHistory: [7, 99, 7] })).toBe(false)
})
