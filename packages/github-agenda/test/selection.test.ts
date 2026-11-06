import { expect, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { AgendaWatchTool } from "@ericsanchezok/synergy-agenda/agenda/tools/agenda-watch"
import { AgendaScheduleTool } from "@ericsanchezok/synergy-agenda/agenda/tools/agenda-schedule"
import { registerWorker } from "../src/worker"

for (const selected of [false, true]) {
  test(`GitHub Agenda selection=${selected} controls tool schemas and guidance`, async () => {
    await using runtime = await testRuntime({
      composition: {
        register() {
          if (selected) registerWorker()
        },
      },
    })
    await runtime.run(async () => {
      const watch = await AgendaWatchTool.init()
      const schedule = await AgendaScheduleTool.init()
      expect(watch.description.includes("onGithub")).toBe(selected)
      expect(schedule.description.includes("GitHub")).toBe(selected)
      const watched = watch.parameters.safeParse({
        agendaTitle: "Wait",
        executionInstructions: "Resume",
        onGithub: { resource: "pr", repository: "acme/project", number: 1 },
      })
      expect(watched.success).toBe(selected)
      const scheduled = schedule.parameters.safeParse({
        agendaTitle: "Wait",
        executionInstructions: "Resume",
        trigger: { type: "github", resource: "pr", repository: "acme/project", number: 1 },
      })
      expect(scheduled.success).toBe(selected)
    })
  })
}
