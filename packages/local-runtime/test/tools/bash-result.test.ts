import { expect, test } from "bun:test"
import { modelVisibleBashResult } from "../../src/tools/bash"

test("foreground bash exposes its shell exit without changing captured output", () => {
  const success = modelVisibleBashResult({
    title: "test",
    metadata: { exit: 0, output: "ok\n" },
    output: "ok\n",
  })
  expect(success.output).toBe("ok\n\nShell exited with code 0.")
  expect(success.metadata.output).toBe("ok\n")

  const failure = modelVisibleBashResult({
    title: "test",
    metadata: { exit: 7, output: "failed" },
    output: "failed",
  })
  expect(failure.output).toEndWith("Shell exited with code 7.")
})

test("foreground bash distinguishes signals and unknown outcomes", () => {
  expect(
    modelVisibleBashResult({ title: "test", metadata: { exit: null, signal: "SIGTERM" }, output: "stopped" }).output,
  ).toEndWith("Shell exited with signal SIGTERM.")
  expect(modelVisibleBashResult({ title: "test", metadata: {}, output: "uncertain" }).output).toEndWith(
    "Shell exit status unknown.",
  )
})

test("background bash keeps its process instructions unchanged", () => {
  const result = {
    title: "background",
    metadata: { background: true, processId: "proc_test" },
    output: "Process ID: proc_test",
  }
  expect(modelVisibleBashResult(result)).toEqual(result)
})

test("long output stays intact and a masked pipeline still reports only its shell status", () => {
  const output = "x".repeat(40_000) + "\nassertion failed inside a filtered pipeline"
  const result = modelVisibleBashResult({
    title: "validation",
    metadata: { exit: 0, output },
    output,
  })
  expect(result.output).toStartWith(output)
  expect(result.output).toEndWith("Shell exited with code 0.")
  expect(result.metadata.output).toBe(output)
})
