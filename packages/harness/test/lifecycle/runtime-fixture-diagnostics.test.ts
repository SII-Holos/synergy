import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import { testRuntime } from "../support/runtime"

test("runtime fixture diagnostics distinguish core shutdown from fixture disposal", async () => {
  using output = spyOn(console, "error")
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const runtime = await testRuntime({
    traceClose: true,
    composition: {
      register() {},
      services: () => ({
        async disposeExtensions() {
          entered.resolve()
          await release.promise
        },
      }),
    },
  })
  const events = (): unknown[] =>
    output.mock.calls
      .filter(([marker]) => marker === "Runtime fixture close phase")
      .map(([, data]) => JSON.parse(String(data)))
  const closing = runtime.close()
  try {
    expect(runtime.close()).toBe(closing)
    await Promise.race([
      entered.promise,
      closing.then(() => {
        throw new Error("Core shutdown skipped the held disposer")
      }),
    ])
    expect(events()).toEqual([{ stage: "runtime", state: "start" }])
    expect((await fs.stat(runtime.host.home)).isDirectory()).toBe(true)
  } finally {
    release.resolve()
    await closing
  }
  expect(runtime.close()).toBe(closing)
  expect(events()).toEqual([
    { stage: "runtime", state: "start" },
    { stage: "runtime", state: "completed" },
    { stage: "fixture", state: "start" },
    { stage: "fixture", state: "completed" },
  ])
  await expect(fs.stat(runtime.host.home)).rejects.toMatchObject({ code: "ENOENT" })
})
