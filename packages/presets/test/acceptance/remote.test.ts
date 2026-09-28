import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { remoteFault } from "../../script/acceptance/remote"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS

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
