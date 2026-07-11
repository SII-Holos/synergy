import { describe, expect, test } from "bun:test"
import { identifyFailedPluginRegistration } from "../../src/plugin/loader"

describe("failed plugin registration identity", () => {
  test("uses migrated identity and approval source when an incompatible archive has no lock entry", () => {
    const spec = "file:///registry/synergy-frontend-kit-0.2.4.synergy-plugin.tgz"
    const result = identifyFailedPluginRegistration({
      spec,
      lockfile: { version: 2, plugins: {} },
      incompatible: [{ pluginId: "synergy-frontend-kit", spec, reason: "reinstallRequired" }],
      approvals: [
        {
          pluginId: "synergy-frontend-kit",
          source: "official",
          version: "0.2.4",
          manifestHash: "old",
          capabilitiesHash: "",
          approvedAt: 1,
          approvedBy: "user",
          trustTier: "declarative",
          approvedCapabilities: [],
          risk: "low",
          status: "needsApproval",
        },
      ],
    })

    expect(result).toEqual({
      pluginId: "synergy-frontend-kit",
      source: "official",
      incompatible: true,
    })

    expect(
      identifyFailedPluginRegistration({
        spec,
        lockfile: {
          version: 2,
          plugins: {
            "legacy-archive-name": {
              spec,
              source: "official",
              version: "0.2.4",
              apiVersion: "3.0",
              generation: "generation",
              resolved: spec,
              manifestHash: "old",
              approvalId: "synergy-frontend-kit",
            },
          },
        },
        incompatible: [],
        approvals: [],
      }),
    ).toEqual({
      pluginId: "synergy-frontend-kit",
      source: "official",
      incompatible: false,
    })
  })
})
