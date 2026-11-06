import { expect, test } from "bun:test"
import path from "node:path"
import { permissionTargets } from "../../script/acceptance/permission-targets"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

const settingsFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
test.skipIf(!settingsFile)(
  "three control profiles authorize the actual native and remote targets",
  async () => {
    const directory = path.join(path.dirname(settingsFile!), "permission-fixtures", crypto.randomUUID())
    using provider = fixtureProvider(() => {
      throw new Error("Permission injection must not request a model")
    })
    const settings = await fixtureSettings(directory, provider.url.toString())
    settings.remote = (await Bun.file(settingsFile!).json()).remote
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(directory, "run"),
      cases: selectCases("permission-targets"),
      inputs: [],
    })
    await execute(plan, { "permission-targets": permissionTargets(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed) {
      const file = Bun.file(path.join(plan.directory, "cases/permission-targets/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id: "permission-targets", status: "passed", attempts: 1, errors: [] }])
    const facts = await Bun.file(path.join(plan.directory, "cases/permission-targets/1/physical.json")).json()
    expect(facts.profiles).toHaveLength(6)
    expect(result.usage.requests).toBe(0)
  },
  180000,
)
