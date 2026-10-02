import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { installedEntrypoints, currentDevUpgrade, verifyInstalledTask } from "../../script/acceptance/installed"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureSettings } from "./support"
import { installedProvider } from "./installed-provider"

test("installed task verification rejects repeated effects, changed bytes and a missing product result", () => {
  const expected = "record from the file"
  const valid = { output: expected, input: expected, effects: "x", completed: true, answer: expected }
  expect(verifyInstalledTask(valid, expected)).toBe(true)
  expect(verifyInstalledTask({ ...valid, effects: "xx" }, expected)).toBe(false)
  expect(verifyInstalledTask({ ...valid, output: expected + "!" }, expected)).toBe(false)
  expect(verifyInstalledTask({ ...valid, completed: false }, expected)).toBe(false)
})

const installed = Boolean(process.env.SYNERGY_ACCEPTANCE_CORE && process.env.SYNERGY_ACCEPTANCE_FULL)
for (const id of ["installed-entrypoints", "current-dev-upgrade"] as const)
  test.skipIf(!installed || (id === "current-dev-upgrade" && !process.env.SYNERGY_ACCEPTANCE_PREVIOUS))(
    `${id} executes installed public entrypoints and independently verifies retained state`,
    async () => {
      await using tmp = await tmpdir()
      using provider = installedProvider()
      const settings = await fixtureSettings(tmp.path, provider.url.toString())
      const catalog = await Bun.file(settings.modelCatalog).json()
      catalog.fixture = {
        id: "fixture",
        name: "Fixture",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        models: {
          model: {
            id: "model",
            name: "Frozen catalog fixture",
            release_date: "2026-09-28",
            reasoning: false,
            tool_call: true,
            attachment: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 128000, output: 2048 },
          },
        },
      }
      settings.modelCatalog = path.join(tmp.path, "catalog.json")
      await Bun.write(settings.modelCatalog, JSON.stringify(catalog))
      settings.config.provider = { fixture: { npm: "@ai-sdk/openai-compatible", env: [] } }
      settings.artifacts = {
        core: process.env.SYNERGY_ACCEPTANCE_CORE!,
        full: process.env.SYNERGY_ACCEPTANCE_FULL!,
        ...(process.env.SYNERGY_ACCEPTANCE_PREVIOUS
          ? { previous: { directory: process.env.SYNERGY_ACCEPTANCE_PREVIOUS, source: "b".repeat(40) } }
          : {}),
      }
      const plan = await makePlan({
        source: "a".repeat(40),
        directory: path.join(tmp.path, "run"),
        cases: selectCases(id),
        inputs: [],
      })
      await execute(
        plan,
        { [id]: id === "installed-entrypoints" ? installedEntrypoints(settings) : currentDevUpgrade(settings) },
        { source: plan.source },
      )
      const result = await report(plan)
      if (!result.passed && process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS) {
        await fs.cp(
          plan.directory,
          path.join(process.env.SYNERGY_ACCEPTANCE_DIAGNOSTICS, `${id}-${crypto.randomUUID()}`),
          { recursive: true },
        )
        console.error(await Bun.file(path.join(plan.directory, `cases/${id}/1/failure.json`)).text())
      }
      expect(result.cases).toEqual([{ id, status: "passed", attempts: 1, errors: [] }])
      expect(result.usage.requests).toBeGreaterThan(0)
      expect(result.usage.unknownUsage).toBe(0)
    },
    300000,
  )
