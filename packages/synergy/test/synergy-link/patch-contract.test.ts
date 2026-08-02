import { describe, expect, test } from "bun:test"
import type { SynergyLinkTargetPatchInput } from "@ericsanchezok/synergy-sdk"
import { SynergyLinkTarget } from "../../src/synergy-link/types"

describe("Synergy Link target patch contract", () => {
  test("source schema accepts non-empty metadata and atomic relink patches", () => {
    expect(SynergyLinkTarget.PatchInput.safeParse({ kind: "metadata", name: "Renamed" }).success).toBe(true)
    expect(
      SynergyLinkTarget.PatchInput.safeParse({ kind: "metadata", enabled: false, allowedAgents: ["ops"] }).success,
    ).toBe(true)
    expect(
      SynergyLinkTarget.PatchInput.safeParse({
        kind: "relink",
        name: "Relinked",
        targetAgentID: "agent_new",
        linkID: "link_new",
      }).success,
    ).toBe(true)
  })

  test("source schema rejects missing kinds, empty metadata patches, and partial locators", () => {
    for (const input of [{}, { kind: "metadata" }]) {
      const result = SynergyLinkTarget.PatchInput.safeParse(input)
      expect(result.success).toBe(false)
    }

    const partial = SynergyLinkTarget.PatchInput.safeParse({
      kind: "relink",
      targetAgentID: "agent_new",
    })
    expect(partial.success).toBe(false)
    if (!partial.success) {
      expect(JSON.stringify(partial.error.issues)).toContain("targetAgentID and linkID must be updated together")
    }
  })

  test("generated SDK type encodes only non-empty metadata or atomic relink variants", () => {
    const metadataOnly: SynergyLinkTargetPatchInput = { kind: "metadata", name: "Renamed" }
    const metadataOnlyEnabled: SynergyLinkTargetPatchInput = {
      kind: "metadata",
      enabled: false,
      allowedAgents: ["ops"],
    }
    const relink: SynergyLinkTargetPatchInput = {
      kind: "relink",
      name: "Relinked",
      targetAgentID: "agent_new",
      linkID: "link_new",
    }

    // @ts-expect-error an empty object is not a valid patch
    const empty: SynergyLinkTargetPatchInput = {}
    // @ts-expect-error metadata patches require at least one changed field
    const emptyMetadata: SynergyLinkTargetPatchInput = { kind: "metadata" }
    // @ts-expect-error targetAgentID without linkID is not a valid patch
    const partialRelink: SynergyLinkTargetPatchInput = { kind: "relink", targetAgentID: "agent_new" }
    // @ts-expect-error linkID without targetAgentID is not a valid patch
    const partialLink: SynergyLinkTargetPatchInput = { kind: "relink", linkID: "link_new" }

    expect([metadataOnly, metadataOnlyEnabled, relink, empty, emptyMetadata, partialRelink, partialLink]).toBeDefined()
  })
})
