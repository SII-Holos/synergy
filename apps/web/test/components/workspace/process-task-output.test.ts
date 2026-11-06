import { expect, test } from "bun:test"
import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { processTaskOutput, toolTaskOutput } from "../../../src/components/workspace/process-task-output"

test("summary presentation separates the generated preamble while preserving report separators and code", () => {
  const trajectory =
    "## Execution Trajectory\n\n**Steps**: 5 | **Tool calls**: 13\n**Phases**: Read(3 steps/12 calls)\n\n### Key Events\n\n★ **Step 5**: Content output (1,138 chars)\n   > ## Result Done ## Summary Review..."
  const report = "## Result\nDone\n\n---\n\n## Summary\n```md\n## Execution Trajectory\n```\n"
  const raw = trajectory + "\n\n---\n\n" + report
  expect(processTaskOutput({ mode: "summary", value: raw })).toEqual({
    raw,
    text: report,
    trajectory,
    steps: 5,
    toolCalls: 13,
  })
})

test("a trace without a report stays available without being presented as a final answer", () => {
  const raw = "## Execution Trajectory\n\n**Steps**: 1 | **Tool calls**: 1\n\n**Phases**: Read(1 steps/1 calls)\n"
  expect(processTaskOutput({ mode: "summary", value: raw })).toEqual({
    raw,
    text: "",
    trajectory: raw.trimEnd(),
    steps: 1,
    toolCalls: 1,
  })
})

test("authored reports and unrecognized summaries remain verbatim", () => {
  const value = "## Execution Trajectory\n\nMy own report\n\n---\n\nKeep this section."
  for (const mode of ["summary", "final_response"]) {
    expect(processTaskOutput({ mode, value })).toEqual({ raw: value, text: value })
  }
  const generated =
    "## Execution Trajectory\n\n**Steps**: 1 | **Tool calls**: 0\n**Phases**: Pure output\n\n---\n\nText"
  expect(processTaskOutput({ mode: "final_response", value: generated })).toEqual({ raw: generated, text: generated })
})

test("structured output stays JSON and absent output stays absent", () => {
  expect(processTaskOutput({ mode: "structured", value: { result: "## literal text" } })).toEqual({
    raw: '{\n  "result": "## literal text"\n}',
    text: '{\n  "result": "## literal text"\n}',
    language: "json",
  })
  for (const output of [undefined, null, "text", { mode: "summary", value: 2 }]) {
    expect(processTaskOutput(output)).toBeUndefined()
  }
})

test("full task results require matching recorded and requested identity and preserve structured data", () => {
  const part = {
    id: "part",
    sessionID: "session",
    messageID: "message",
    callID: "call",
    type: "tool",
    tool: "task_output",
    state: {
      status: "completed",
      input: { taskId: "task" },
      title: "Task",
      output: "Receipt",
      time: { start: 1, end: 2 },
      metadata: {
        found: true,
        taskId: "task",
        status: "error",
        output: { mode: "structured", value: { accepted: false } },
      },
    },
  } satisfies ToolPart
  expect(toolTaskOutput(part)).toEqual({
    status: "error",
    report: { raw: '{\n  "accepted": false\n}', text: '{\n  "accepted": false\n}', language: "json" },
  })
  for (const metadata of [
    { ...part.state.metadata, found: false },
    { ...part.state.metadata, taskId: "another" },
    { ...part.state.metadata, mode: "tail" },
    { ...part.state.metadata, output: undefined },
  ])
    expect(toolTaskOutput({ ...part, state: { ...part.state, metadata } })).toBeUndefined()
  for (const input of [null, "raw", [], {}, { taskId: "task", mode: "progress" }])
    expect(toolTaskOutput({ ...part, state: { ...part.state, input } })).toBeUndefined()
  expect(toolTaskOutput({ ...part, tool: "another" })).toBeUndefined()
  expect(
    toolTaskOutput({ ...part, state: { status: "running", input: { taskId: "task" }, time: { start: 1 } } }),
  ).toBeUndefined()
})
