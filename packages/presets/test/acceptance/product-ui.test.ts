import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { acceptanceRuntime } from "../../script/acceptance/runtime"
import { fixtureProvider, fixtureSettings } from "./support"
import { productProvider } from "./product-provider"
import { desktopInput } from "../../script/acceptance/product-ui"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

test("the isolated product acceptance Runtime serves its explicitly selected Web artifact", async () => {
  await using tmp = await tmpdir()
  using provider = fixtureProvider(() => "ready")
  const settings = await fixtureSettings(tmp.path, provider.url.toString())
  const web = path.join(tmp.path, "web")
  await Bun.write(path.join(web, "index.html"), "<html><head></head><body>frozen product artifact</body></html>")
  await using host = await acceptanceRuntime(path.join(tmp.path, "runtime"), settings, {
    http: true,
    webAppDirectory: web,
  })
  const response = await fetch(`http://127.0.0.1:${host.runtime.server!.port}/aG9tZQ/session`)
  expect(response.status).toBe(200)
  expect(await response.text()).toContain("frozen product artifact")
}, 30000)

const productTest = process.env.SYNERGY_ACCEPTANCE_WEB && process.env.SYNERGY_ACCEPTANCE_ELECTRON ? test : test.skip
productTest(
  "Desktop composer preserves actual uploads and drafts across pause, continuation, cancellation and resource selection",
  async () => {
    await using tmp = await tmpdir()
    using provider = productProvider()
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
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
      cases: selectCases("desktop-input"),
      inputs: [],
    })
    await execute(plan, { "desktop-input": desktopInput(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed && process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS) {
      await fs.cp(
        plan.directory,
        path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `desktop-${crypto.randomUUID()}`),
        { recursive: true },
      )
      console.error(await Bun.file(path.join(plan.directory, "cases/desktop-input/1/failure.json")).text())
    }
    expect(result.cases).toEqual([{ id: "desktop-input", status: "passed", attempts: 1, errors: [] }])
  },
  240000,
)
