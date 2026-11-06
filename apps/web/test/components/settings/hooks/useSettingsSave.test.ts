import { describe, expect, test } from "bun:test"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import { buildFieldDomainMap, groupPatchByDomain } from "../../../../src/components/settings/domain-routing"

const domains: ConfigDomainSummary[] = [
  domain("general", ["snapshot", "theme", "username"]),
  domain("models", ["model", "mini_model", "quick_switcher"]),
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

  test("routes quick switcher and model role patches by config-domain ownership", () => {
    const grouped = groupPatchByDomain(
      { quick_switcher: { models: [] }, model: "openai/gpt-5.5", mini_model: "openai/gpt-5.5-mini" },
      domains,
    )
    expect(grouped.get("models")).toEqual({
      quick_switcher: { models: [] },
      model: "openai/gpt-5.5",
      mini_model: "openai/gpt-5.5-mini",
    })
  })

  test("does not route product update mode into server config", () => {
    expect(() => groupPatchByDomain({ autoupdate: true }, domains)).toThrow("not owned by a config domain")
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
