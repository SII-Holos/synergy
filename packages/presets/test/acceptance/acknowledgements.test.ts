import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { acknowledgements } from "../../script/acceptance/acknowledgements"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS

test.skipIf(!labFile)(
  "lost physical allocation and release replies reconcile without duplicate resources or effects",
  async () => {
    const settings = await Bun.file(labFile!).json()
    const cases = selectCases("fault-allocation-ack,fault-release-ack")
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(path.dirname(labFile!), "ack-fixtures", crypto.randomUUID()),
      cases,
      inputs: [],
    })
    await execute(plan, Object.fromEntries(cases.map((scenario) => [scenario.id, acknowledgements(settings)])), {
      source: plan.source,
    })
    const result = await report(plan)
    if (!result.passed) {
      const retained = path.join(path.dirname(labFile!), `failed-ack-fixture-${crypto.randomUUID()}`)
      await fs.mkdir(retained, { mode: 0o700 })
      await fs.cp(plan.directory, retained, { recursive: true })
      for (const scenario of cases) {
        const file = Bun.file(path.join(plan.directory, "cases", scenario.id, "1/failure.json"))
        if (await file.exists()) console.error(await file.text())
      }
    }
    expect(result.cases).toEqual(
      cases.map((scenario) => ({ id: scenario.id, status: "passed", attempts: 1, errors: [] })),
    )
    await fs.rm(plan.directory, { recursive: true })
  },
  120_000,
)
