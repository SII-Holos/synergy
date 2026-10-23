import { composeWithExperiments } from "../support/selected-components"
import { expect, test } from "bun:test"
import path from "node:path"
import { Config } from "@ericsanchezok/synergy-harness/config"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { plugins } from "@ericsanchezok/synergy-plugin-host/component"
import { mcp } from "@ericsanchezok/synergy-mcp/component"
import { boss } from "@ericsanchezok/synergy-boss/component"
import { library } from "@ericsanchezok/synergy-library/component"
import { agenda } from "@ericsanchezok/synergy-agenda/component"

for (const owner of ["mcp", "boss"] as const) {
  test(`${owner} migrates retained execution settings after Core has completed the shared migration`, async () => {
    await using home = await runtimeHome()
    const root = path.join(home.host.root, "config", "synergy.d")
    const source = path.join(root, "120-runtime.jsonc")
    const legacy = { experimental: { mcp_timeout: 99, boss_mode: true, futureOwner: { value: 7 } } }
    const raw = JSON.stringify(legacy, null, 2)
    await Bun.write(source, raw)
    await Bun.write(
      path.join(root, "40-mcp.jsonc"),
      JSON.stringify({ mcpDefaults: { callTimeout: 10, connectTimeout: 20 } }),
    )
    let retained = ""
    for (const selection of ["core", "selected", "core", "selected"]) {
      const selected = selection === "selected"
      await using runtime = await testRuntime({
        home: home.host.home,
        composition: composeWithExperiments([
          localRuntime({ workers: false, environment: false }),
          ...(selected ? (owner === "mcp" ? [plugins(), mcp()] : [library(), agenda(), boss()]) : []),
        ]),
      })
      await runtime.run(async () => {
        const config = await Config.globalResolved()
        const stored = await Bun.file(source).json()
        if (!retained && !selected) expect(await Bun.file(source).text()).toBe(raw)
        if (selected) {
          if (owner === "mcp") {
            expect(config.mcpDefaults).toMatchObject({ callTimeout: 99, connectTimeout: 20 })
            expect(stored.experimental).toEqual({ boss_mode: true, futureOwner: { value: 7 } })
          } else {
            expect(config.boss).toMatchObject({ enabled: true })
            expect(stored.experimental).toEqual({ mcp_timeout: 99, futureOwner: { value: 7 } })
          }
          const receipt = await Storage.read<Record<string, number>>(["meta", "migration", `log-${owner}-config`])
          expect(receipt[`20261012-${owner}-execution-config-owner`]).toBeGreaterThan(0)
          if (retained) expect(await Bun.file(source).text()).toBe(retained)
          retained = await Bun.file(source).text()
        } else {
          expect(config).not.toHaveProperty("mcpDefaults")
          expect(config).not.toHaveProperty("boss")
          await Config.domainUpdate("general", { logLevel: "WARN" })
          if (retained) expect(await Bun.file(source).text()).toBe(retained)
        }
        const receipt = await Storage.read<Record<string, number>>(["meta", "migration", "log-config"])
        expect(receipt["20260907-config-execution-domains"]).toBeGreaterThan(0)
      })
    }
  }, 30_000)
}
