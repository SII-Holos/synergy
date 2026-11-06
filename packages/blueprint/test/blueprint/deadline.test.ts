import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { note } from "@ericsanchezok/synergy-note/component"
import { blueprint } from "../../src/component"
import { setDeadlineTimer } from "../../src/blueprint/deadline"

test("closing a Blueprint Runtime cancels only its deadline timers", async () => {
  const open = () =>
    testRuntime({
      composition: RuntimeComponents.compose([
        localRuntime({ workers: false, environment: false }),
        note(),
        blueprint(),
      ]),
    })
  await using first = await open()
  await using second = await open()
  const expired: string[] = []
  first.run(() => setDeadlineTimer("home", "bll_same", 100, () => expired.push("closed")))
  second.run(() => setDeadlineTimer("home", "bll_same", 100, () => expired.push("live")))
  await first.close()
  await Bun.sleep(200)
  expect(expired).toEqual(["live"])
})
