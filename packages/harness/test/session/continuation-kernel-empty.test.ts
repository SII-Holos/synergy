import { expect, spyOn, test } from "bun:test"
import { ContinuationKernel } from "../../src/session/continuation-kernel"
import { Log } from "../../src/util/log"
import { testRuntime } from "../support/runtime"

test("an independently composed runtime warns and has no continuation when no policies are registered", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    await Log.init({ print: true })
    using output = spyOn(process.stderr, "write").mockReturnValue(true)
    expect(await ContinuationKernel.propose("ses_does_not_exist")).toBeUndefined()
    expect(output.mock.calls.map(([chunk]) => String(chunk)).join("")).toContain(
      "continuation kernel has no policies registered",
    )
  })
})
