import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { fixtureSettings } from "./support"
import { productProvider } from "./product-provider"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { Settings } from "../../script/acceptance/settings"

const remoteProductTest =
  process.env.SYNERGY_ACCEPTANCE_WEB &&
  process.env.SYNERGY_ACCEPTANCE_ELECTRON &&
  process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
    ? test
    : test.skip

remoteProductTest(
  "Desktop selects remote compute lazily, preserves the file binding on reload and saves files before UI release",
  async () => {
    await using tmp = await tmpdir()
    using provider = productProvider()
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
    const remote = Settings.parse(await Bun.file(process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS!).json())
    settings.remote = remote.remote
    settings.artifacts = {
      web: process.env.SYNERGY_ACCEPTANCE_WEB!,
      desktop: {
        directory: process.env.SYNERGY_ACCEPTANCE_DESKTOP!,
        entry: "dist/main.js",
        electronDirectory: process.env.SYNERGY_ACCEPTANCE_ELECTRON!,
        executable: "Contents/MacOS/Electron",
      },
    }
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(tmp.path, "run"),
      cases: selectCases("desktop-remote"),
      inputs: [],
    })
    const { desktopRemote } = await import("../../script/acceptance/product-remote")
    await execute(plan, { "desktop-remote": desktopRemote(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed && process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS) {
      await fs.cp(
        plan.directory,
        path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `desktop-remote-${crypto.randomUUID()}`),
        { recursive: true },
      )
      console.error(await Bun.file(path.join(plan.directory, "cases/desktop-remote/1/failure.json")).text())
    }
    expect(result.cases).toEqual([{ id: "desktop-remote", status: "passed", attempts: 1, errors: [] }])
    const physical = await Bun.file(path.join(plan.directory, "cases/desktop-remote/1/physical.json")).json()
    expect(physical.samples.map((sample: { containers: string[] }) => sample.containers.length)).toEqual([0, 1, 0])
    expect(physical.effects).toBe("x")
    expect(physical.savedHash).toBe(physical.remoteHash)
  },
  180000,
)
