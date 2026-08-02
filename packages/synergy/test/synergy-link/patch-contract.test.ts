import { describe, expect, test } from "bun:test"
import type { SynergyLinkTargetPatchInput } from "@ericsanchezok/synergy-sdk"
import { SynergyLinkTarget } from "../../src/synergy-link/types"

describe("Synergy Link target patch contract", () => {
  test("source schema accepts metadata-only and atomic relink patches", () => {
    expect(SynergyLinkTarget.PatchInput.safeParse({ name: "Renamed" }).success).toBe(true)
    expect(SynergyLinkTarget.PatchInput.safeParse({ enabled: false, allowedAgents: ["ops"] }).success).toBe(true)
    expect(
      SynergyLinkTarget.PatchInput.safeParse({
        name: "Relinked",
        targetAgentID: "agent_new",
        linkID: "link_new",
      }).success,
    ).toBe(true)
  })

  test("source schema rejects empty patches and partial locators", () => {
    const empty = SynergyLinkTarget.PatchInput.safeParse({})
    expect(empty.success).toBe(false)
    if (!empty.success) {
      expect(JSON.stringify(empty.error.issues)).toContain("At least one field is required")
    }

    const partial = SynergyLinkTarget.PatchInput.safeParse({ targetAgentID: "agent_new" })
    expect(partial.success).toBe(false)
    if (!partial.success) {
      expect(JSON.stringify(partial.error.issues)).toContain("targetAgentID and linkID must be updated together")
    }
  })

  test("generated SDK type encodes the same two variants", () => {
    // Metadata-only patches remain valid.
    const metadataOnly: SynergyLinkTargetPatchInput = { name: "Renamed" }
    const metadataOnlyEnabled: SynergyLinkTargetPatchInput = { enabled: false, allowedAgents: ["ops"] }
    // Atomic relink patches remain valid.
    const relink: SynergyLinkTargetPatchInput = { name: "Relinked", targetAgentID: "agent_new", linkID: "link_new" }

    // A partial locator must not typecheck: targetAgentID requires linkID and vice versa.
    // @ts-expect-error targetAgentID without linkID is not a valid patch
    const partialRelink: SynergyLinkTargetPatchInput = { targetAgentID: "agent_new" }
    // @ts-expect-error linkID without targetAgentID is not a valid patch
    const partialLink: SynergyLinkTargetPatchInput = { linkID: "link_new" }

    expect([metadataOnly, metadataOnlyEnabled, relink, partialRelink, partialLink]).toBeDefined()
  })
})
