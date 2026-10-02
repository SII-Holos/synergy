import { expect, test } from "bun:test"
import { createWelcomeSelection } from "../../../../src/components/session/welcome/selection"

function storage() {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
  }
}

test("a welcome stays stable until explicit new, which excludes its predecessor", () => {
  const selection = createWelcomeSelection({ ids: ["chain", "stack", "orbit"], random: () => 0 })
  const first = selection.current("one")
  expect(selection.current("one")).toBe(first)
  const second = selection.begin("one")
  expect(second.sceneId).not.toBe(first.sceneId)
  expect(selection.current("one")).toBe(second)
  expect(selection.begin("one").sceneId).not.toBe(second.sceneId)
})

test("reload restores selection and seed, with independent connection and tab histories", () => {
  const tab = storage()
  const first = createWelcomeSelection({ ids: ["a", "b", "c"], storage: tab, random: () => 0.7 })
  const a = first.current("one")
  first.begin("two")
  expect(first.current("one")).toBe(a)
  const reload = createWelcomeSelection({ ids: ["a", "b", "c"], storage: tab, random: () => 0 })
  expect(reload.current("one")).toEqual(a)
  expect(reload.begin("one").sceneId).not.toBe(a.sceneId)
  expect(
    createWelcomeSelection({ ids: ["a", "b", "c"], storage: storage(), random: () => 0 }).current("one").sceneId,
  ).toBe("a")
})

test("all remaining entries, including a fourth extension, are selectable with equal intervals", () => {
  const picks = [0, 1 / 3, 2 / 3].map((draw) => {
    let value = 0
    const s = createWelcomeSelection({ ids: ["a", "b", "c", "fourth"], random: () => value })
    s.current("one")
    value = draw
    return s.begin("one").sceneId
  })
  expect(picks).toEqual(["b", "c", "fourth"])
})

test("unavailable storage and removed scene IDs recover without making selection unstable", () => {
  const broken = {
    getItem: () => {
      throw new Error("blocked")
    },
    setItem: () => {
      throw new Error("quota")
    },
  }
  const s = createWelcomeSelection({ ids: ["only"], storage: broken })
  expect(s.current("one")).toBe(s.current("one"))
  expect(s.begin("one").sceneId).toBe("only")
  const tab = storage()
  createWelcomeSelection({ ids: ["removed"], storage: tab }).current("one")
  expect(createWelcomeSelection({ ids: ["available"], storage: tab }).current("one").sceneId).toBe("available")
})
