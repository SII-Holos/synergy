import { describe, expect, test } from "bun:test"
import type { PluginManifestType } from "../src/index"
import { computeManifestHash, computePermissionsHash, permissionsHashPayload, stablePluginJson } from "../src/integrity"

const manifest = {
  manifestVersion: 1,
  apiVersion: "3.0",
  id: "integrity-fixture",
  name: "Integrity Fixture",
  version: "1.2.3",
  description: "Hash contract fixture",
  capabilities: [
    { id: "task.delegate", constraints: { maxRuntimeMs: 30_000, agents: ["planner"] } },
    { id: "asset.write" },
  ],
  contributions: [
    {
      kind: "operation",
      id: "plan",
      type: "query",
      expose: ["ui", "sdk"],
      requires: ["task.delegate"],
      input: { type: "object" },
      output: { type: "object" },
    },
    {
      kind: "ui.workbenchPanel",
      id: "panel",
      label: "Panel",
      order: 0,
      surface: "side",
      cardinality: "singleton",
      component: { entry: "ui/index.js", exportName: "Panel" },
      requires: ["asset.write"],
    },
  ],
  artifacts: {
    generation: "generation-1",
    runtime: { entry: "runtime/index.js", sha256: "a".repeat(64) },
    ui: { entry: "ui/index.js", sha256: "b".repeat(64) },
  },
} satisfies PluginManifestType

describe("plugin integrity hashes", () => {
  test("serializes object keys deterministically", () => {
    expect(stablePluginJson({ z: 1, a: { y: 2, b: 3 } })).toBe('{"a":{"b":3,"y":2},"z":1}')
  })

  test("binds capability constraints, contribution requirements, exposure, and trusted UI", () => {
    expect(permissionsHashPayload(manifest)).toEqual({
      capabilities: manifest.capabilities,
      contributionRequirements: [
        {
          kind: "operation",
          id: "plan",
          requires: ["task.delegate"],
          expose: ["ui", "sdk"],
        },
        {
          kind: "ui.workbenchPanel",
          id: "panel",
          requires: ["asset.write"],
          trustedComponent: true,
        },
      ],
    })
    expect(computePermissionsHash(manifest)).toBe("22a13a39c98931a30d6a42956fd02330b43e1a8e0c1e7867ace738ff0b987732")
    expect(computePermissionsHash(manifest, ["asset.write"])).toBe(
      "d568047799bb6ecaf0de95fb1661a0d8536075fa1ec04f3b63093dcad2462454",
    )
    expect(computeManifestHash(manifest)).toBe("77e02aad36c52877d0524cb183a5a6a746711cc57c36e8f9932e43fce8a46622")
  })
})
