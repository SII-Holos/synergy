import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { remoteFault } from "../../script/acceptance/remote"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS

test.skipIf(!labFile)(
  "a catalog-only model remains available after the isolated controller clears its cache and restarts",
  async () => {
    await using tmp = await tmpdir()
    using provider = fixtureProvider(
      (input) =>
        JSON.stringify(input.messages).match(/acceptance record identifier: ([a-f0-9]{32})/)?.[1] ??
        "Recovery acceptance",
    )
    const settings = await fixtureSettings(tmp.path, provider.url.toString())
    const catalog = await Bun.file(settings.modelCatalog).json()
    const example = Object.values(catalog.anthropic.models)[0] as Record<string, unknown>
    catalog.fixture = {
      id: "fixture",
      name: "Fixture",
      npm: "@ai-sdk/openai-compatible",
      env: [],
      models: {
        "catalog-only": { ...example, id: "catalog-only", name: "Catalog only", reasoning: false, tool_call: true },
      },
    }
    settings.modelCatalog = path.join(tmp.path, "catalog.json")
    await Bun.write(settings.modelCatalog, JSON.stringify(catalog))
    settings.modelID = "catalog-only"
    settings.config = {
      ...settings.config,
      model: "fixture/catalog-only",
      nano_model: "fixture/catalog-only",
      mini_model: "fixture/catalog-only",
      vision_model: "fixture/catalog-only",
      provider: { fixture: { npm: "@ai-sdk/openai-compatible", env: [] } },
    }
    const cases = selectCases("fault-command-crash")
    const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
    const remote = (await Bun.file(labFile!).json()).remote
    await execute(plan, { "fault-command-crash": remoteFault({ ...settings, remote }) }, { source: plan.source })
    const outcome = await report(plan)
    expect(outcome.cases[0]).toEqual({ id: "fault-command-crash", status: "passed", attempts: 1, errors: [] })
    expect(outcome.usage.requests).toBeGreaterThanOrEqual(2)
  },
  120_000,
)

test.skipIf(!labFile)(
  "remote recovery survives actual controller death without repeating effects or losing unsaved files",
  async () => {
    await using tmp = await tmpdir()
    const settings = await Bun.file(labFile!).json()
    const cases = selectCases("fault-command-crash,fault-save-crash").map((scenario) => ({ ...scenario, live: false }))
    const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
    await execute(plan, Object.fromEntries(cases.map((scenario) => [scenario.id, remoteFault(settings)])), {
      source: plan.source,
    })
    const outcome = await report(plan)
    if (!outcome.passed)
      for (const scenario of cases) {
        const file = Bun.file(path.join(plan.directory, "cases", scenario.id, "1/failure.json"))
        if (await file.exists()) console.error(await file.text())
      }
    expect(outcome.cases).toEqual(
      cases.map((scenario) => ({ id: scenario.id, status: "passed", attempts: 1, errors: [] })),
    )
  },
  180_000,
)
