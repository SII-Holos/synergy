import { describe, expect, test } from "bun:test"
import {
  finishActivityCountTransition,
  reduceActivityCountTransition,
  type ActivityCountTransition,
} from "../../src/components/activity-count-transition"

function start(value: number, identity = "turn-a") {
  return reduceActivityCountTransition(undefined, { identity, value, reducedMotion: false })
}

function increase(state: ActivityCountTransition, value: number) {
  return reduceActivityCountTransition(state, { identity: state.identity, value, reducedMotion: false })
}

describe("activity count transition", () => {
  test("shows the first mounted value immediately", () => {
    expect(start(9)).toEqual({ identity: "turn-a", current: 9, animating: false, revision: 0 })
  })

  test.each([
    [9, 10],
    [20, 21],
    [99, 100],
  ])("uses one discrete old/new transition for %i to %i", (before, after) => {
    const next = increase(start(before), after)

    expect(next).toMatchObject({ current: after, previous: before, animating: true, revision: 1 })
  })

  test("cancels the active transition and targets only the latest rapid update", () => {
    const first = increase(start(9), 10)
    const latest = increase(first, 12)

    expect(latest).toMatchObject({ current: 12, previous: 10, animating: true, revision: 2 })
    expect(finishActivityCountTransition(latest, first.revision)).toBe(latest)
    expect(finishActivityCountTransition(latest, latest.revision)).toEqual({
      identity: "turn-a",
      current: 12,
      animating: false,
      revision: 2,
    })
  })

  test("snaps on a decrease or turn identity reset", () => {
    expect(increase(start(20), 8)).toEqual({ identity: "turn-a", current: 8, animating: false, revision: 1 })
    expect(reduceActivityCountTransition(start(20), { identity: "turn-b", value: 21, reducedMotion: false })).toEqual({
      identity: "turn-b",
      current: 21,
      animating: false,
      revision: 1,
    })
  })

  test("replaces directly when reduced motion is requested", () => {
    expect(reduceActivityCountTransition(start(99), { identity: "turn-a", value: 100, reducedMotion: true })).toEqual({
      identity: "turn-a",
      current: 100,
      animating: false,
      revision: 1,
    })
  })

  test("does not schedule another transition for an unchanged value", () => {
    const state = start(21)
    expect(increase(state, 21)).toBe(state)
  })
})
