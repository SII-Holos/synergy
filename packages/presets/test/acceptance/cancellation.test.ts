import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { cancellations } from "../../script/acceptance/cancellation"
import { selectCases } from "../../script/acceptance/catalog"
import { execute, makePlan, report } from "../../script/acceptance/runner"
import { fixtureProvider, fixtureSettings } from "./support"

for (const target of ["native", "remote"] as const)
  test.skipIf(process.platform === "win32" || (target === "remote" && !process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS))(
    `${target} cancellation observes waiting, acquired, running and output-draining phases`,
    async () => {
      await using tmp = await tmpdir()
      using provider = fixtureProvider(() => {
        throw new Error("Cancellation fixture must not call a model")
      })
      const remote = process.env.SYNERGY_ACCEPTANCE_REMOTE_SETTINGS
      const settings =
        target === "remote" ? await Bun.file(remote!).json() : await fixtureSettings(tmp.path, provider.url.toString())
      const directory =
        target === "remote"
          ? path.join(path.dirname(remote!), "cancel-fixtures", crypto.randomUUID())
          : path.join(tmp.path, "run")
      const cases = selectCases("fault-cancel-phases")
      const plan = await makePlan({ source: "a".repeat(40), directory, cases, inputs: [] })
      await execute(plan, { "fault-cancel-phases": cancellations(settings, [target]) }, { source: plan.source })
      const result = await report(plan)
      if (!result.passed) {
        const failure = Bun.file(path.join(directory, "cases/fault-cancel-phases/1/failure.json"))
        if (await failure.exists()) console.error(await failure.text())
      }
      expect(result.cases).toEqual([{ id: "fault-cancel-phases", status: "passed", attempts: 1, errors: [] }])
      const observed = await Bun.file(path.join(directory, "cases/fault-cancel-phases/1/physical.json")).json()
      expect(observed.targets).toEqual([target])
      expect(observed.phases.map((phase: { stage: string }) => phase.stage)).toEqual([
        "waiting",
        "acquired",
        "running",
        "draining",
      ])
      expect(observed.phases.every((phase: { verified: boolean }) => phase.verified)).toBe(true)
      expect(result.usage.requests).toBe(0)
      if (target === "remote") await fs.rm(directory, { recursive: true })
    },
    120_000,
  )
