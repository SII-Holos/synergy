import { expect, spyOn, test } from "bun:test"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { Plugin } from "@ericsanchezok/synergy-plugin-host/plugin"
import { triggerAgendaHook } from "@ericsanchezok/synergy-agenda/agenda/hooks"
import { registerWorker } from "../src/worker"

for (const selected of [false, true]) {
  test(`Agenda hook delivery requires its selected Plugin bridge: ${selected}`, async () => {
    const calls: string[] = []
    const delivery = spyOn(Plugin, "trigger").mockImplementation(async (name, _input, output) => {
      calls.push(name)
      return output
    })
    try {
      await using runtime = await testRuntime({
        composition: {
          register() {
            if (selected) registerWorker()
          },
        },
      })
      await runtime.run(async () => {
        const result = { control: { skip: false } }
        expect(await triggerAgendaHook("agenda.run.before", { item: { id: "item" } }, result)).toBe(result)
        expect(calls).toEqual(selected ? ["agenda.run.before"] : [])
      })
    } finally {
      delivery.mockRestore()
    }
  })
}
