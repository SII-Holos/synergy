import { describe, expect, test } from "bun:test"
import { parseClaudeCodeTranscript, decodeProjectDir } from "../../src/session/import/claude-code"
import { parseCodexTranscript } from "../../src/session/import/codex"
import { parseJsonLines, isoToEpoch } from "../../src/session/import/shared"
import { SessionImport } from "../../src/session/session-import"
import { SessionExport } from "../../src/session/session-export"

function claudeTranscript(): string {
  return [
    JSON.stringify({
      type: "summary",
      summary: "Fix the parser bug",
      leafUuid: "abc-root",
      timestamp: "2025-01-10T10:00:00.000Z",
    }),
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2025-01-10T10:01:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Please fix the parser" }] },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a1",
      timestamp: "2025-01-10T10:02:00.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me look at the parser" },
          { type: "text", text: "I found the bug" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "src/parser.ts" } },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: "u2",
      timestamp: "2025-01-10T10:03:00.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "function parse() {}" }],
      },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: "a2",
      timestamp: "2025-01-10T10:04:00.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Fixed" }] },
    }),
  ].join("\n")
}

function codexTranscript(): string {
  return [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2025-02-01T10:00:00.000Z",
      payload: { id: "rollout-abc", cwd: "/repo", source: "codex", cli_version: "0.137.0" },
    }),
    JSON.stringify({
      type: "turn_context",
      timestamp: "2025-02-01T10:00:00.000Z",
      payload: { cwd: "/repo", model: "gpt-5", summary: "Codex session summary" },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2025-02-01T10:01:00.000Z",
      payload: { type: "user_message", message: "Fix the build" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2025-02-01T10:02:00.000Z",
      payload: {
        type: "function_call",
        call_id: "call_1",
        name: "exec_command",
        arguments: JSON.stringify({ command: "bun test" }),
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2025-02-01T10:03:00.000Z",
      payload: { type: "function_call_output", call_id: "call_1", output: "tests passed" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2025-02-01T10:04:00.000Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Build fixed" }] },
    }),
    JSON.stringify({
      type: "event_msg",
      timestamp: "2025-02-01T10:05:00.000Z",
      payload: { type: "token_count", info: { total: 100 } },
    }),
  ].join("\n")
}

describe("parseJsonLines", () => {
  test("parses valid lines and counts malformed ones", () => {
    const stats = { skippedLines: 0, unknownTypes: 0, warnings: [] }
    const entries = parseJsonLines('{"a":1}\nnot-json\n{"b":2}\n', stats)
    expect(entries).toHaveLength(2)
    expect(stats.skippedLines).toBe(1)
  })
})

describe("isoToEpoch", () => {
  test("converts ISO strings and passes through epoch numbers", () => {
    expect(isoToEpoch("2025-01-10T10:00:00.000Z")).toBe(Date.parse("2025-01-10T10:00:00.000Z"))
    expect(isoToEpoch(12345)).toBe(12345)
    expect(isoToEpoch("garbage")).toBeUndefined()
    expect(isoToEpoch(undefined)).toBeUndefined()
  })
})

describe("decodeProjectDir", () => {
  test("decodes URL-encoded Claude Code project names", () => {
    expect(decodeProjectDir("-Users-me-project")).toBe("/Users/me/project")
    expect(decodeProjectDir("-Users-me-my-app")).toBe("/Users/me/my/app")
    expect(decodeProjectDir("C%3A%5CUsers%5Cme")).toBe("C:\\Users\\me")
    expect(decodeProjectDir("not-a-path")).toBeUndefined()
    expect(decodeProjectDir("")).toBeUndefined()
  })
})

describe("parseClaudeCodeTranscript", () => {
  test("converts user/assistant turns, tool calls, and titles", () => {
    const { report, stats } = parseClaudeCodeTranscript(claudeTranscript())
    expect(report.sessions).toHaveLength(1)
    const session = report.sessions[0]
    expect(session.info.title).toBe("Fix the parser bug")
    expect(session.info.scope).toMatchObject({ id: "unknown", directory: "" })
    expect(session.messages.length).toBe(3)
    expect(stats.skippedLines).toBe(0)
    expect(stats.unknownTypes).toBe(0)

    const user = session.messages[0]
    expect(user.info.role).toBe("user")
    expect((user.info as { isRoot?: boolean }).isRoot).toBe(true)
    expect((user.info as any).agent).toBe("synergy")
    expect(user.parts).toHaveLength(1)
    expect(user.parts[0]).toMatchObject({ type: "text", text: "Please fix the parser" })

    const assistant = session.messages[1]
    expect(assistant.info.role).toBe("assistant")
    expect((assistant.info as any).parentID).toBe(user.info.id)
    const toolPart = assistant.parts.find((part) => part.type === "tool") as any
    expect(toolPart).toMatchObject({ type: "tool", callID: "toolu_1", tool: "Read" })
    expect(toolPart.state.status).toBe("completed")
    expect(toolPart.state.output).toBe("function parse() {}")

    // thinking blocks excluded by default
    expect(assistant.parts.some((part) => part.type === "reasoning")).toBe(false)
  })

  test("includes thinking when requested", () => {
    const { report } = parseClaudeCodeTranscript(claudeTranscript(), { includeThinking: true })
    const assistant = report.sessions[0].messages[1]
    expect(assistant.parts.some((part) => part.type === "reasoning")).toBe(true)
  })

  test("skips sidechain sessions by default and includes them when requested", () => {
    const sidechain = JSON.stringify({
      type: "user",
      isSidechain: true,
      uuid: "side1",
      timestamp: "2025-01-10T11:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "subagent" }] },
    })
    const text = claudeTranscript() + "\n" + sidechain
    const { report: without } = parseClaudeCodeTranscript(text)
    expect(without.sessions[0].messages.length).toBe(3)

    const { report: withSide } = parseClaudeCodeTranscript(text, { includeSidechains: true })
    expect(withSide.sessions[0].messages.length).toBe(4)
  })

  test("handles malformed lines and unknown types gracefully", () => {
    const text = claudeTranscript() + '\n{"type":"unknown-type","foo":1}\nnot-json\n'
    const { report, stats } = parseClaudeCodeTranscript(text)
    expect(report.sessions[0].messages.length).toBe(3)
    expect(stats.skippedLines).toBe(1)
    expect(stats.unknownTypes).toBe(1)
  })
})

describe("parseCodexTranscript", () => {
  test("converts messages, tool calls, and metadata", () => {
    const { report, stats } = parseCodexTranscript(codexTranscript())
    const session = report.sessions[0]
    expect(session.info.title).toBe("Codex session summary")
    expect(session.info.scope).toMatchObject({ id: "unknown", directory: "/repo" })
    expect(session.messages.length).toBe(3)
    expect(stats.skippedLines).toBe(0)
    expect(stats.unknownTypes).toBe(0)

    const user = session.messages[0]
    expect(user.info.role).toBe("user")
    expect((user.info as { isRoot?: boolean }).isRoot).toBe(true)
    expect(user.parts).toHaveLength(1)
    expect(user.parts[0]).toMatchObject({ type: "text", text: "Fix the build" })

    const call = session.messages[1]
    expect(call.info.role).toBe("assistant")
    const tool = call.parts[0] as any
    expect(tool.type).toBe("tool")
    expect(tool.callID).toBe("call_1")
    expect(tool.tool).toBe("exec_command")
    expect(tool.state.status).toBe("completed")
    expect(tool.state.output).toBe("tests passed")

    const reply = session.messages[2]
    expect(reply.info.role).toBe("assistant")
    expect(reply.parts[0]).toMatchObject({ type: "text", text: "Build fixed" })
  })

  test("keeps reasoning when requested", () => {
    const text =
      codexTranscript() +
      "\n" +
      JSON.stringify({
        type: "response_item",
        timestamp: "2025-02-01T10:06:00.000Z",
        payload: { type: "reasoning", summary: "I reasoned about the fix" },
      })
    const { report: without } = parseCodexTranscript(text)
    expect(without.sessions[0].messages.some((m) => m.parts.some((p) => p.type === "reasoning"))).toBe(false)

    const { report: withReasoning } = parseCodexTranscript(text, { includeReasoning: true })
    expect(withReasoning.sessions[0].messages.some((m) => m.parts.some((p) => p.type === "reasoning"))).toBe(true)
  })

  test("parses custom tool calls and outputs", () => {
    const text = [
      JSON.stringify({
        type: "response_item",
        timestamp: "2025-02-01T10:00:00.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "call_x",
          name: "web_search",
          input: { query: "x" },
          status: "completed",
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2025-02-01T10:01:00.000Z",
        payload: { type: "custom_tool_call_output", call_id: "call_x", output: "results" },
      }),
    ].join("\n")
    const { report } = parseCodexTranscript(text)
    const session = report.sessions[0]
    expect(session.messages.length).toBe(1)
    const tool = session.messages[0].parts[0] as any
    expect(tool.tool).toBe("web_search")
    expect(tool.state.status).toBe("completed")
    expect(tool.state.output).toBe("results")
  })
})

describe("foreign report schema", () => {
  test("claude-code and codex reports parse as valid SessionExport.Report", () => {
    const claude = parseClaudeCodeTranscript(claudeTranscript()).report
    const codex = parseCodexTranscript(codexTranscript()).report
    for (const report of [claude, codex]) {
      const parsed = SessionExport.Report.safeParse(report)
      expect(parsed.success).toBe(true)
      expect(SessionImport.parse(Buffer.from(JSON.stringify(report)))).toBeDefined()
    }
  })
})
