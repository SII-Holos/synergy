import { describe, expect, test } from "bun:test"
import { setupI18n } from "@lingui/core"
import { needsFullAccessAcknowledgement } from "../../../src/components/dialog/full-access-ack-model"
import { fullAccessConfirm } from "../../../src/components/dialog/full-access-confirm"

const i18n = setupI18n({ locale: "en" })

describe("full access acknowledgement", () => {
  test("prompts when Full Access is selected and the risk is not yet acknowledged", () => {
    expect(needsFullAccessAcknowledgement({ targetProfile: "full_access", acknowledged: false })).toBe(true)
    expect(needsFullAccessAcknowledgement({ targetProfile: "full_access" })).toBe(true)
  })

  test("never prompts for a profile other than Full Access", () => {
    for (const targetProfile of ["guarded", "autonomous", undefined, ""]) {
      expect(needsFullAccessAcknowledgement({ targetProfile, acknowledged: false })).toBe(false)
    }
  })

  test("does not prompt again once the risk is acknowledged", () => {
    expect(needsFullAccessAcknowledgement({ targetProfile: "full_access", acknowledged: true })).toBe(false)
  })

  test("does not re-prompt when Full Access is already the active profile", () => {
    // Re-selecting the mode already in force must not interrupt the human again.
    expect(
      needsFullAccessAcknowledgement({
        targetProfile: "full_access",
        currentProfile: "full_access",
        acknowledged: false,
      }),
    ).toBe(false)
  })

  test("still prompts when switching to Full Access from another profile", () => {
    expect(
      needsFullAccessAcknowledgement({
        targetProfile: "full_access",
        currentProfile: "guarded",
        acknowledged: false,
      }),
    ).toBe(true)
  })
})

describe("full access warning copy", () => {
  test("warns that permission checks and sandboxing are removed, with a danger tone", () => {
    const copy = fullAccessConfirm()

    expect(copy.tone).toBe("danger")
    expect(i18n._(copy.title)).toBe("Enable Full Access?")
    const description = i18n._(copy.description)
    expect(description).toContain("removes Synergy's permission checks")
    expect(description).toContain("sandboxing")
    expect(description).toContain("without asking you first")
  })

  test("labels the escape hatch rather than the destructive action", () => {
    const copy = fullAccessConfirm()

    expect(i18n._(copy.confirmLabel!)).toBe("Enable Full Access")
    expect(i18n._(copy.cancelLabel!)).toBe("Keep current mode")
  })
})
