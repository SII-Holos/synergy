import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { executionDrain } from "../../script/acceptance/execution-drain"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"

const labFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
test.skipIf(!labFile)(
  "remote PTY disconnect retains quiet work, drains background output and saves before reclaim",
  async () => {
    const settings = await Bun.file(labFile!).json()
    const cases = selectCases("execution-drain").map((scenario) => ({ ...scenario, live: false }))
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(path.dirname(labFile!), "drain-fixtures", crypto.randomUUID()),
      cases,
      inputs: [],
    })
    await execute(plan, { "execution-drain": executionDrain(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed) {
      const retained = path.join(path.dirname(labFile!), `failed-drain-fixture-${crypto.randomUUID()}`)
      await fs.mkdir(retained, { mode: 0o700 })
      await fs.cp(plan.directory, retained, { recursive: true })
      const file = Bun.file(path.join(plan.directory, "cases/execution-drain/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id: "execution-drain", status: "passed", attempts: 1, errors: [] }])
    await fs.rm(plan.directory, { recursive: true })
  },
  120_000,
)
