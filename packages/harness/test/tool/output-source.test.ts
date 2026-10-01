import { expect, test } from "bun:test"
import { testRuntime } from "../support/runtime"
import { ToolOutputSource } from "../../src/tool/output-source"
import { Truncate } from "../../src/tool/truncation"
import { Tool } from "../../src/tool/tool"
import { z } from "zod"

test("host externalization preserves the complete bytes and exposes only its model-readable reference", async () => {
  const captured: ToolOutputSource.Input[] = []
  await using runtime = await testRuntime({
    register: () =>
      ToolOutputSource.register({
        async save(input) {
          captured.push(structuredClone(input))
          return `/workspace/tool-results/${input.id}`
        },
      }),
  })
  await runtime.run(async () => {
    const text = "完整结果\n".repeat(20000)
    const tool = Tool.define("fixture", {
      description: "Fixture",
      parameters: z.object({}),
      execute: async () => ({ title: "fixture", output: text, metadata: {} as Record<string, unknown> }),
    })
    const result = await (
      await tool.init()
    ).execute(
      {},
      {
        sessionID: "ses_fixture",
        messageID: "msg_fixture",
        callID: "call_fixture",
        agent: "fixture",
        abort: new AbortController().signal,
        ask: async () => {},
        metadata() {},
      },
    )
    expect(captured).toHaveLength(1)
    expect(captured[0]!.text).toBe(text)
    expect(captured[0]!.origin).toEqual({ sessionID: "ses_fixture", messageID: "msg_fixture", callID: "call_fixture" })
    expect(result.metadata.outputPath).toStartWith("/workspace/tool-results/")
    expect(result.output).toContain(result.metadata.outputPath as string)
    expect(result.output).not.toContain(runtime.host.root)
  })
})

test("output sources are isolated, sealed and bypassed for bounded output", async () => {
  let saved = 0
  await using first = await testRuntime({
    register: () =>
      ToolOutputSource.register({
        async save() {
          saved++
          return "/workspace/first"
        },
      }),
  })
  await using second = await testRuntime({
    register: () =>
      ToolOutputSource.register({
        async save() {
          return "/workspace/second"
        },
      }),
  })
  expect((await first.run(() => Truncate.output("small"))).truncated).toBe(false)
  expect(saved).toBe(0)
  const one = await first.run(() => Truncate.output("large".repeat(20), { maxBytes: 1 }))
  const two = await second.run(() => Truncate.output("large".repeat(20), { maxBytes: 1 }))
  expect(one.truncated && one.outputPath).toBe("/workspace/first")
  expect(two.truncated && two.outputPath).toBe("/workspace/second")
  await first.run(async () =>
    expect(() => ToolOutputSource.register({ save: async () => "/workspace/other" })).toThrow("before opening"),
  )
})

test("a failed host save never produces a private-file fallback or false success", async () => {
  await using runtime = await testRuntime({
    register: () =>
      ToolOutputSource.register({
        async save() {
          throw new Error("workspace save failed")
        },
      }),
  })
  await expect(runtime.run(() => Truncate.output("large".repeat(20), { maxBytes: 1 }))).rejects.toThrow(
    "workspace save failed",
  )
})
