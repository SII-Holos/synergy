import { expect, test } from "bun:test"
import path from "node:path"
import { fileServices } from "../../script/acceptance/file-services"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

const settingsFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
test.skipIf(!settingsFile)(
  "file consumers share native and remote views and reject a late plugin write after an external edit",
  async () => {
    const directory = path.join(path.dirname(settingsFile!), "file-service-fixtures", crypto.randomUUID())
    using provider = fixtureProvider(() => {
      throw new Error("File service injection must not request a model")
    })
    const settings = await fixtureSettings(directory, provider.url.toString())
    settings.remote = (await Bun.file(settingsFile!).json()).remote
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(directory, "run"),
      cases: selectCases("file-services"),
      inputs: [],
    })
    await execute(plan, { "file-services": fileServices(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed) {
      const file = Bun.file(path.join(plan.directory, "cases/file-services/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id: "file-services", status: "passed", attempts: 1, errors: [] }])
    const facts = await Bun.file(path.join(plan.directory, "cases/file-services/1/physical.json")).json()
    expect(facts.targets).toHaveLength(2)
    expect(facts.targets.every((target: { lateWriteRejected: boolean }) => target.lateWriteRejected)).toBe(true)
    expect(result.usage.requests).toBe(0)
  },
  180000,
)
