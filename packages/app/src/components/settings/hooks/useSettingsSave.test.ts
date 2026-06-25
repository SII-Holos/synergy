import { describe, expect, test } from "bun:test"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { buildFieldDomainMap, groupPatchByDomain, strategyForPatch } from "../domain-routing"

const domains: ConfigDomainSummary[] = [
  domain("general", ["snapshot", "autoupdate", "theme", "username"]),
  domain("models", ["model", "mini_model"]),
  domain("permissions", ["permission", "controlProfile", "sandbox", "smartAllow"]),
]

describe("settings save routing", () => {
  test("derives field ownership from domain summaries", () => {
    const fieldDomain = buildFieldDomainMap(domains)
    expect(fieldDomain.get("snapshot")).toBe("general")
    expect(fieldDomain.get("controlProfile")).toBe("permissions")
  })

  test("groups patch keys by derived domain ownership", () => {
    const grouped = groupPatchByDomain({ snapshot: true, controlProfile: "guarded" }, domains)
    expect(grouped.get("general")).toEqual({ snapshot: true })
    expect(grouped.get("permissions")).toEqual({ controlProfile: "guarded" })
  })

  test("throws when a patch field is not owned by any domain", () => {
    expect(() => groupPatchByDomain({ unknownField: true }, domains)).toThrow("not owned by a config domain")
  })

  test("throws when a patch field has no save strategy", () => {
    expect(() => strategyForPatch({ unknownField: true })).toThrow("does not define a save strategy")
  })
})

function domain(id: ConfigDomainSummary["id"], ownedKeys: string[]): ConfigDomainSummary {
  return {
    id,
    filename: `${id}.jsonc`,
    label: id,
    path: `/tmp/${id}.jsonc`,
    ownedKeys,
    mergePolicy: "merge",
    reloadTargets: ["config"],
    uiSection: id,
    importable: true,
    config: {},
  }
}
