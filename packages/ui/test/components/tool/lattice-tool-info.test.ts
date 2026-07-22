import { describe, expect, test } from "bun:test"
import { getLatticeToolPresentation } from "../../../src/components/tool/classifier"

describe("Lattice tool presentation", () => {
  test("summarizes Pathway tools without exposing runtime identifiers", () => {
    const info = getLatticeToolPresentation(
      "pathway_read",
      {},
      { completed: 2, total: 5, currentStepTitle: "Ship UI" },
    )!

    expect(info.icon).toBe("route")
    expect(typeof info.title).not.toBe("string")
    expect(info.subtitle).toBe("Ship UI")
    expect(info.args).toEqual(["2/5"])
    expect(JSON.stringify(info)).not.toContain("runID")
  })

  test("uses semantic submit copy and a Blueprint title instead of its ID", () => {
    const info = getLatticeToolPresentation(
      "lattice_submit",
      { action: "submit_blueprint", blueprintID: "internal-note-id" },
      { blueprintTitle: "Release Blueprint", source: "tool" },
    )!

    expect(info.icon).toBe("circle-check")
    expect((info.title as { message?: string }).message).toBe("Select Blueprint")
    expect(info.subtitle).toBe("Release Blueprint")
    expect(info.args).toEqual(["Chat"])
    expect(JSON.stringify(info)).not.toContain("internal-note-id")
  })

  test("shows semantic approval source and reason", () => {
    const info = getLatticeToolPresentation(
      "lattice_submit",
      { action: "approve_execution", reason: "Reviewed with the user" },
      { source: "panel" },
    )!

    expect((info.title as { message?: string }).message).toBe("Approve Blueprint execution")
    expect(info.subtitle).toBe("Reviewed with the user")
    expect(info.args).toEqual(["Panel"])
  })
})
