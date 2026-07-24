import { describe, expect, test } from "bun:test"
import type { ConfigDomainSummary } from "@ericsanchezok/synergy-sdk/client"
import {
  buildFieldDomainMap,
  groupPatchByDomain,
  strategyForPatch,
} from "../../../../src/components/settings/domain-routing"
import { createSettingsSaveQueue } from "../../../../src/components/settings/hooks/settings-save-queue"
import { MODEL_ROLES } from "../../../../src/components/settings/types"

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

  test("throws when a patch field has no save strategy", () => {
    expect(() => strategyForPatch({ unknownField: true })).toThrow("does not define a save strategy")
  })

  test("routes quick switcher patches through background save", () => {
    const grouped = groupPatchByDomain({ quick_switcher: { models: [] } }, domains)
    expect(grouped.get("models")).toEqual({ quick_switcher: { models: [] } })
    expect(strategyForPatch({ quick_switcher: { models: [] } })).toEqual(["background"])
  })

  test("routes model role patches through explicit save", () => {
    for (const role of MODEL_ROLES) {
      expect(strategyForPatch({ [role.key]: "openai/gpt-5.5" })).toEqual(["explicit"])
    }
    expect(strategyForPatch({ model: "openai/gpt-5.5", theme: "dark" })).toEqual(["explicit", "background"])
  })

  test("does not route product update mode into server config", () => {
    expect(() => groupPatchByDomain({ autoupdate: true }, domains)).toThrow("not owned by a config domain")
    expect(() => strategyForPatch({ autoupdate: true })).toThrow("does not define a save strategy")
  })
})

describe("settings background save queue", () => {
  test("reconciles only the latest change when an older write is still in flight", async () => {
    const firstWrite = deferred()
    const writes: number[] = []
    const reconciled: number[] = []
    const queue = createSettingsSaveQueue()

    const firstGeneration = queue.supersede()
    const first = queue.enqueue(firstGeneration, {
      write: async () => {
        writes.push(4)
        await firstWrite.promise
      },
      reconcile: async () => {
        reconciled.push(4)
      },
      onSuccess: () => {},
      onError: () => {},
    })
    await Promise.resolve()

    const latestGeneration = queue.supersede()
    const latest = queue.enqueue(latestGeneration, {
      write: async () => {
        writes.push(8)
      },
      reconcile: async () => {
        reconciled.push(8)
      },
      onSuccess: () => {},
      onError: () => {},
    })

    firstWrite.resolve()
    await Promise.all([first, latest])

    expect(writes).toEqual([4, 8])
    expect(reconciled).toEqual([8])
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

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
