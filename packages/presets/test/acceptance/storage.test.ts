import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { persistence } from "../../script/acceptance/persistence"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

for (const backend of ["sqlite", "postgres"] as const)
  test.skipIf(backend === "postgres" && !process.env.SYNERGY_ACCEPTANCE_POSTGRES_FILE)(
    `${backend} acceptance rejects half writes and duplicate submissions across restart and export/import`,
    async () => {
      await using tmp = await tmpdir()
      using provider = fixtureProvider(() => {
        throw new Error("Persistence scenario must not call a model")
      })
      const settings = await fixtureSettings(tmp.path, provider.url.toString())
      if (backend === "postgres") settings.postgres = { urlFile: process.env.SYNERGY_ACCEPTANCE_POSTGRES_FILE! }
      const cases = selectCases(`storage-${backend}`)
      const plan = await makePlan({ source: "a".repeat(40), directory: path.join(tmp.path, "run"), cases, inputs: [] })
      await execute(plan, { [`storage-${backend}`]: persistence(settings) }, { source: plan.source })
      const result = await report(plan)
      if (!result.passed) {
        const failure = Bun.file(path.join(plan.directory, "cases", `storage-${backend}`, "1/failure.json"))
        if (await failure.exists()) console.error(await failure.text())
      }
      expect(result.cases).toEqual([{ id: `storage-${backend}`, status: "passed", attempts: 1, errors: [] }])
      expect(result.usage.requests).toBe(0)
      const external = await Bun.file(
        path.join(plan.directory, "cases", `storage-${backend}`, "1/physical.json"),
      ).json()
      expect(external.receipts).toBe(1)
      expect(external.effectCount).toBe(1)
      expect(external.rolledBackCount).toBe(0)
      expect(external.remainingReferences).toBeGreaterThanOrEqual(1)
    },
    90_000,
  )
