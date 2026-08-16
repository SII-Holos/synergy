import { describe, expect, test } from "bun:test"
import { SynergyLinkDisplay } from "../src/display"

describe("synergy-link display identifiers", () => {
  test("identifier renders values and falls back to none", () => {
    expect(SynergyLinkDisplay.identifier("agent_a")).toBe("agent_a")
    expect(SynergyLinkDisplay.identifier(null)).toBe("none")
    expect(SynergyLinkDisplay.identifier(undefined)).toBe("none")
    expect(SynergyLinkDisplay.identifier("")).toBe("none")
    expect(SynergyLinkDisplay.identifier(null, { missing: "unset" })).toBe("unset")
  })

  test("maybeIdentifier separates unknown values from missing ones", () => {
    expect(SynergyLinkDisplay.maybeIdentifier("agent_a")).toBe("agent_a")
    expect(SynergyLinkDisplay.maybeIdentifier(null)).toBe("none")
    expect(SynergyLinkDisplay.maybeIdentifier(42)).toBe("unknown")
    expect(SynergyLinkDisplay.maybeIdentifier(42, { unknown: "?" })).toBe("?")
    expect(SynergyLinkDisplay.maybeIdentifier(undefined, { missing: "unset" })).toBe("unset")
  })

  test("identifierList joins entries with a configurable separator", () => {
    expect(SynergyLinkDisplay.identifierList(["a", "b"])).toBe("a, b")
    expect(SynergyLinkDisplay.identifierList(["a", "b"], { separator: " | " })).toBe("a | b")
    expect(SynergyLinkDisplay.identifierList(undefined)).toBe("none")
    expect(SynergyLinkDisplay.identifierList([])).toBe("none")
    expect(SynergyLinkDisplay.identifierList([], { missing: "empty" })).toBe("empty")
  })
})
