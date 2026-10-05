import { describe, expect, test } from "bun:test"
import { PERMISSION_MODES, permissionModeVisual } from "../../../src/components/prompt-input/permission-modes"

describe("permission mode visuals", () => {
  test("distinguishes Full Access without changing guarded or autonomous visuals", () => {
    expect(permissionModeVisual("full_access")).toMatchObject({
      icon: "permission.fullAccess",
      iconClass: "text-text-permission-full-access",
    })
    expect(permissionModeVisual("guarded")).toMatchObject({
      icon: "permission.guarded",
      iconClass: "text-text-on-success-base",
    })
    expect(permissionModeVisual("autonomous")).toMatchObject({
      icon: "permission.autonomous",
      iconClass: "text-text-interactive-base",
    })
    expect(new Set(PERMISSION_MODES.map((mode) => mode.iconClass)).size).toBe(3)
  })

  test("keeps unknown and missing profiles on the guarded fallback", () => {
    expect(permissionModeVisual(undefined)).toBe(permissionModeVisual("guarded"))
    expect(permissionModeVisual("unknown")).toBe(permissionModeVisual("guarded"))
  })
})
