import { describe, expect, test } from "bun:test"
import {
  createTargetRequestController,
  normalizeAllowedAgents,
  reconcileTargetDraft,
  targetFormReady,
  targetListState,
} from "./synergy-link-panel-model"

describe("Synergy Link settings form", () => {
  test("normalizes a comma-separated agent allowlist", () => {
    expect(normalizeAllowedAgents("build, synergy, build,  review ")).toEqual(["build", "synergy", "review"])
  })

  test("requires all three target locator fields", () => {
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: "link_builder" })).toBe(true)
    expect(targetFormReady({ name: "Builder", targetAgentID: "", linkID: "link_builder" })).toBe(false)
    expect(targetFormReady({ name: "Builder", targetAgentID: "agent_builder", linkID: ":local" })).toBe(false)
  })

  test("cancels an in-flight target request without waiting for the network", () => {
    const requests = createTargetRequestController()
    const controller = requests.start()

    requests.cancel()

    expect(controller.signal.aborted).toBe(true)
  })

  test("keeps a replacement target request active when an older request finishes", () => {
    const requests = createTargetRequestController()
    const first = requests.start()
    const second = requests.start()

    requests.finish(first)
    expect(first.signal.aborted).toBe(true)
    expect(second.signal.aborted).toBe(false)

    requests.cancel()
    expect(second.signal.aborted).toBe(true)
  })
  test("preserves dirty target fields across background refreshes", () => {
    expect(
      reconcileTargetDraft({
        current: "Unsaved name",
        previousServer: "Old name",
        nextServer: "Old name",
        targetChanged: false,
      }),
    ).toBe("Unsaved name")
    expect(
      reconcileTargetDraft({
        current: "Old name",
        previousServer: "Old name",
        nextServer: "Updated elsewhere",
        targetChanged: false,
      }),
    ).toBe("Updated elsewhere")
    expect(
      reconcileTargetDraft({
        current: "Unsaved name",
        previousServer: "Old name",
        nextServer: "Different target",
        targetChanged: true,
      }),
    ).toBe("Different target")
  })

  test("keeps target fetch errors distinct from an empty successful result", () => {
    expect(targetListState({ loading: false, error: new Error("offline"), count: 0 })).toBe("error")
    expect(targetListState({ loading: false, error: undefined, count: 0 })).toBe("empty")
    expect(targetListState({ loading: false, error: undefined, count: 2 })).toBe("ready")
  })
})
