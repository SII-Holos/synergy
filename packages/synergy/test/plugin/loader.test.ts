import { describe, expect, test } from "bun:test"
import { compilePluginManifest, definePlugin, capability } from "@ericsanchezok/synergy-plugin"
import { tmpdir } from "../fixture/fixture"
import { ScopeContext } from "../../src/scope/context"
import { saveApproval } from "../../src/plugin/consent/approval-store"
import { getAllStatus } from "../../src/plugin/status"
import { resetAllPluginState, identifyFailedPluginRegistration } from "../../src/plugin/loader"
import { pathToFileURL } from "url"
import { sha256File } from "../../src/util/crypto"
import fs from "fs/promises"
import path from "path"

describe("loader approval identity via Status", () => {
  test("configured plugin with mismatched approval hash shows approval-disabled with canonical data", async () => {
    const pluginTmp = await tmpdir()
    const runtimeDir = path.join(pluginTmp.path, "runtime")
    await fs.mkdir(runtimeDir, { recursive: true })
    await Bun.write(path.join(runtimeDir, "index.js"), "export default {}")
    const runtimePath = path.join(runtimeDir, "index.js")

    const definition = definePlugin({
      id: "approval-loader-test",
      version: "2.0.0",
      description: "Approval loader fixture",
      capabilities: [capability("workspace.write"), capability("session.write")],
      contributions: [],
    } as any)
    const manifest = compilePluginManifest(definition, {
      generation: "loader-test-gen",
      runtime: { entry: "runtime/index.js", sha256: sha256File(runtimePath) },
    })
    await Bun.write(path.join(pluginTmp.path, "plugin.json"), JSON.stringify(manifest))
    const spec = pathToFileURL(pluginTmp.path).href

    await using tmp = await tmpdir({ git: true, config: { plugin: [spec] } })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await saveApproval({
          pluginId: "approval-loader-test",
          source: "local",
          version: "2.0.0",
          manifestHash: "wrong-hash-ffff",
          capabilitiesHash: "wrong-cap-hash",
          approvedAt: Date.now() - 1000,
          approvedBy: "user",
          trustTier: "declarative",
          approvedCapabilities: ["workspace.write", "session.write"],
          risk: "high",
          status: "approved",
        })

        await resetAllPluginState()
        const statuses = await getAllStatus()
        const disabled = statuses.find((s) => s.id === "approval-loader-test" && s.health === "disabled")
        expect(disabled).toBeDefined()
        if (!disabled) return

        expect(disabled.name).toBe(manifest.name)
        expect(disabled.version).toBe("2.0.0")
        expect(disabled.generation).toBe("loader-test-gen")
        expect(disabled.disabledPhase).toBe("approval")
        expect(disabled.loaded).toBe(false)
        expect(disabled.capabilities).toContain("workspace.write")
        expect(disabled.risk).toBe("high")
        expect(disabled.installation.kind).toBe("directory")
        expect((disabled as any).manifest).toBeUndefined()
      },
    })
  })

  test("resolve failure shows degraded identity, not approval", async () => {
    const brokenSpec = "file:///nonexistent/path/plugin.json"
    await using tmp = await tmpdir({ git: true, config: { plugin: [brokenSpec] } })
    const scope = await tmp.scope()

    await ScopeContext.provide({
      scope,
      fn: async () => {
        await resetAllPluginState()
        const statuses = await getAllStatus()
        const degraded = statuses.find((s) => s.health === "disabled" && s.disabledPhase !== "approval")
        expect(degraded).toBeDefined()
        if (degraded) {
          expect(degraded.disabledPhase).not.toBe("approval")
          expect(degraded.capabilities).toEqual([])
          expect(degraded.version).toBeUndefined()
        }
      },
    })
  })
})

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
  })
})
