import { expect, test } from "bun:test"
import {
  createStory,
  chooseStory,
  backStory,
  storyNodes,
  type Story,
} from "../../../../src/components/session/welcome/story/model"

function follow(actions: string[]): Story {
  return actions.reduce((state, action) => chooseStory(state, action), createStory())
}
test("the authored story has eight reachable nodes and three distinct endings", () => {
  expect(Object.keys(storyNodes)).toHaveLength(8)
  const reached = new Set<string>()
  const visit = (state: Story) => {
    if (reached.has(state.node)) return
    reached.add(state.node)
    for (const choice of storyNodes[state.node].choices) visit(chooseStory(state, choice.id))
  }
  visit(createStory())
  expect(reached.size).toBe(8)
  const endings = [
    follow(["enter", "letter", "owner", "return"]),
    follow(["enter", "books", "reading"]),
    follow(["enter", "books", "map"]),
  ]
  expect(new Set(endings.map((s) => s.node)).size).toBe(3)
  for (const state of endings) expect(storyNodes[state.node].ending).toBe(true)
})
test("choices are node-owned; backtracking and restart preserve a coherent story", () => {
  const initial = createStory()
  expect(chooseStory(initial, "map")).toBe(initial)
  expect(backStory(initial)).toBe(initial)
  const state = follow(["enter", "letter", "owner"])
  expect(backStory(state).node).toBe("letter")
  expect(backStory(backStory(state)).node).toBe("foyer")
  expect(state.node).toBe("visitor")
  expect(createStory()).toEqual(initial)
})
