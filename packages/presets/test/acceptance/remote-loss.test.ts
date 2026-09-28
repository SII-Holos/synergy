import { expect, test } from "bun:test"
import path from "node:path"
import { remoteLoss } from "../../script/acceptance/remote-loss"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

const settingsFile = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
test.skipIf(!settingsFile)(
  "remote loss keeps authority explicit across disconnect, host exit and container removal",
  async () => {
    const directory = path.join(path.dirname(settingsFile!), "remote-loss-fixtures", crypto.randomUUID())
    using provider = fixtureProvider(() => {
      throw new Error("Deterministic remote loss must not request a model")
    })
    const settings = await fixtureSettings(directory, provider.url.toString())
    settings.remote = (await Bun.file(settingsFile!).json()).remote
    const plan = await makePlan({
      source: "a".repeat(40),
      directory: path.join(directory, "run"),
      cases: selectCases("fault-remote-loss").map((entry) => ({ ...entry, live: false })),
      inputs: [],
    })
    await execute(plan, { "fault-remote-loss": remoteLoss(settings) }, { source: plan.source })
    const result = await report(plan)
    if (!result.passed) {
      const file = Bun.file(path.join(plan.directory, "cases/fault-remote-loss/1/failure.json"))
      if (await file.exists()) console.error(await file.text())
    }
    expect(result.cases).toEqual([{ id: "fault-remote-loss", status: "passed", attempts: 1, errors: [] }])
    const facts = await Bun.file(path.join(plan.directory, "cases/fault-remote-loss/1/physical.json")).json()
    expect(facts.variants).toHaveLength(3)
    expect(facts.variants.every((entry: { bytesRecovered: boolean }) => entry.bytesRecovered)).toBe(true)
    expect(result.usage.requests).toBe(0)
  },
  240000,
)
