import { describe, expect, test } from "bun:test"
import { Installation } from "../../src/global/installation"

describe("desktop-managed upgrade", () => {
  test("does not execute package-manager upgrades", async () => {
    const err = await Installation.upgrade("desktop", "999.0.0").catch((error) => error)

    expect(err).toBeInstanceOf(Installation.DesktopManagedUpdateError)
    expect(err.data.message).toContain("Synergy is installed with the Desktop app")
    expect(err.data.message).toContain("Desktop updates are managed from the Synergy app")
  })
})
