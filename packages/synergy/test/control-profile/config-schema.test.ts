import { describe, expect, test } from "bun:test"
import { ControlProfileId } from "../../src/config/schema"

describe("ControlProfileId schema", () => {
  test("valid profile ids parse successfully", () => {
    for (const id of ["manual", "guarded", "autonomous", "full_access"]) {
      const result = ControlProfileId.safeParse(id)
      expect(result.success).toBe(true)
    }
  })

  test("invalid profile id fails validation", () => {
    const result = ControlProfileId.safeParse("bogus")
    expect(result.success).toBe(false)
  })

  test("empty string is rejected", () => {
    const result = ControlProfileId.safeParse("")
    expect(result.success).toBe(false)
  })

  test("undefined is rejected", () => {
    const result = ControlProfileId.safeParse(undefined)
    expect(result.success).toBe(false)
  })
})

describe("Config schema accepts controlProfile", () => {
  const { Info } = require("../../src/config/schema")

  test("top-level controlProfile accepts valid value", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      controlProfile: "manual",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.controlProfile).toBe("manual")
    }
  })

  test("top-level controlProfile defaults to undefined (guarded at resolution time)", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.controlProfile).toBeUndefined()
    }
  })

  test("per-agent controlProfile accepts valid value", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      agent: {
        "synergy-max": {
          controlProfile: "autonomous",
        },
      },
    })
    expect(result.success).toBe(true)
  })

  test("per-agent controlProfile with invalid value fails config validation", () => {
    // controlProfile is typed as ControlProfileId, so "bogus" is rejected at parse time.
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      agent: {
        "synergy-max": {
          controlProfile: "bogus",
        },
      },
    })
    expect(result.success).toBe(false)
  })

  test("existing permission config coexists with controlProfile", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      controlProfile: "guarded",
      permission: {
        edit: "allow",
        bash: "ask",
      },
    })
    expect(result.success).toBe(true)
  })
})
