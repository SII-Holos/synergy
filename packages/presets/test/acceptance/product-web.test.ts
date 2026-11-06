import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { fixtureSettings } from "./support"
import { productProvider } from "./product-provider"
import { webReconnect } from "../../script/acceptance/product-web"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

const productTest = process.env.SYNERGY_ACCEPTANCE_WEB && process.env.SYNERGY_ACCEPTANCE_CHROMIUM ? test : test.skip
productTest(
  "production Web retains old pages, pending input and an uploaded draft after transport loss and refresh",
  async () => {
    await using tmp = await tmpdir()
    using provider = productProvider()
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
    settings.artifacts = { web: process.env.SYNERGY_ACCEPTANCE_WEB! }
    settings.chromium = process.env.SYNERGY_ACCEPTANCE_CHROMIUM!
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(tmp.path, "run"),
      cases: selectCases("web-reconnect"),
      inputs: [],
    })
    await execute(plan, { "web-reconnect": webReconnect(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed && process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS) {
      await fs.cp(plan.directory, path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `web-${crypto.randomUUID()}`), {
        recursive: true,
      })
      const failure = Bun.file(path.join(plan.directory, "cases/web-reconnect/1/failure.json"))
      if (await failure.exists()) console.error(await failure.text())
    }
    expect(result.cases).toEqual([{ id: "web-reconnect", status: "passed", attempts: 1, errors: [] }])
  },
  240000,
)
