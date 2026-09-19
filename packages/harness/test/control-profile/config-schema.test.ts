import { describe, expect, test } from "bun:test"
import { ControlProfileId } from "../../src/config/schema"

describe("ControlProfileId schema", () => {
  test("valid profile ids parse successfully", () => {
    for (const id of ["guarded", "autonomous", "full_access"]) {
      const result = ControlProfileId.safeParse(id)
      expect(result.success).toBe(true)
    }
  })

  test("removed manual profile id fails validation", () => {
    const result = ControlProfileId.safeParse("manual")
    expect(result.success).toBe(false)
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
      controlProfile: "guarded",
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.controlProfile).toBe("guarded")
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

  test("smartAllow accepts boolean values", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      smartAllow: true,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.smartAllow).toBe(true)
    }
  })
})

describe("Config schema accepts the non-interactive profile key", () => {
  const { Info } = require("../../src/config/schema")

  test("accepts autonomous and full_access", () => {
    for (const value of ["autonomous", "full_access"]) {
      const result = Info.safeParse({
        $schema: "file:///test/schema.json",
        nonInteractiveControlProfile: value,
      })
      expect(result.success).toBe(true)
      if (result.success) expect(result.data.nonInteractiveControlProfile).toBe(value)
    }
  })

  test("rejects guarded, because an unattended ask can never be answered", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      nonInteractiveControlProfile: "guarded",
    })
    expect(result.success).toBe(false)
  })

  test("rejects an unknown profile id", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      nonInteractiveControlProfile: "bogus",
    })
    expect(result.success).toBe(false)
  })

  test("defaults to undefined so the resolver owns the autonomous default", () => {
    const result = Info.safeParse({ $schema: "file:///test/schema.json" })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.nonInteractiveControlProfile).toBeUndefined()
  })

  test("accepts the Full Access acknowledgement as a boolean", () => {
    const result = Info.safeParse({
      $schema: "file:///test/schema.json",
      fullAccessAcknowledged: true,
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.fullAccessAcknowledged).toBe(true)
  })

  test("both keys belong to the permissions domain", async () => {
    const { ConfigDomain } = await import("../../src/config/domain")
    expect(ConfigDomain.domainForKey("nonInteractiveControlProfile")?.id).toBe("permissions")
    expect(ConfigDomain.domainForKey("fullAccessAcknowledged")?.id).toBe("permissions")
  })
})
