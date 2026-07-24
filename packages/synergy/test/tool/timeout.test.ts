import { describe, expect, test } from "bun:test"
import { ToolTimeout } from "../../src/tool/timeout"

const toolTimeoutMs = 300_000

function metadata(tool: string, args: Record<string, any> = {}, mcpCallTimeoutMs?: number) {
  return ToolTimeout.metadataForTool({
    tool,
    args,
    toolTimeoutMs,
    mcpCallTimeoutMs,
  })
}

describe("ToolTimeout", () => {
  test("enforces a hard deadline when execution ignores abort", async () => {
    const parent = new AbortController()
    const deadline = ToolTimeout.executionDeadline({
      signal: parent.signal,
      timeoutMs: 10,
      label: "Test tool",
    })

    try {
      const operation = new Promise<never>(() => {})
      await expect(deadline.run(operation)).rejects.toMatchObject({
        name: "TimeoutError",
        message: "Test tool timed out after 10ms.",
      })
      expect(deadline.signal.aborted).toBe(true)
    } finally {
      deadline.dispose()
    }
  })

  test("uses operation timeout for search tools", () => {
    expect(metadata("glob")).toMatchObject({
      toolTimeoutMs,
      operationTimeoutMs: 15_000,
      displayMs: 15_000,
      source: "search",
    })
    expect(metadata("list").operationTimeoutMs).toBe(15_000)
    expect(metadata("scan_files").operationTimeoutMs).toBe(10_000)
    expect(metadata("scan_files", { timeoutMs: 2_500 }).operationTimeoutMs).toBe(2_500)
    expect(metadata("ast_grep").operationTimeoutMs).toBe(60_000)
    expect(metadata("parse_code").operationTimeoutMs).toBe(60_000)
  })

  test("uses effective clamped timeout for webfetch", () => {
    expect(metadata("webfetch").operationTimeoutMs).toBe(30_000)
    expect(metadata("webfetch", { timeout: 300 })).toMatchObject({
      operationTimeoutMs: 120_000,
      displayMs: 120_000,
      source: "fetch",
    })
  })

  test("preserves 300s defaults for task tools", () => {
    expect(metadata("task")).toMatchObject({
      operationTimeoutMs: 300_000,
      displayMs: 300_000,
      source: "auto_background",
    })
    expect(metadata("task_output", { block: true })).toMatchObject({
      operationTimeoutMs: 300_000,
      displayMs: 300_000,
      source: "wait",
    })
  })

  test("uses bash auto-background metadata by default and supports timeoutSeconds", () => {
    expect(metadata("bash")).toMatchObject({
      operationTimeoutMs: 30_000,
      displayMs: 30_000,
      source: "auto_background",
    })
    expect(metadata("bash", { backgroundAfterSeconds: 5 })).toMatchObject({
      operationTimeoutMs: 5_000,
      displayMs: 5_000,
      source: "auto_background",
    })
    expect(metadata("bash", { timeoutSeconds: 7 })).toMatchObject({
      operationTimeoutMs: 7_000,
      displayMs: 7_000,
      source: "wait",
    })
    expect(metadata("bash", { backgroundAfterSeconds: 5, timeoutSeconds: 7 })).toMatchObject({
      operationTimeoutMs: 5_000,
      displayMs: 5_000,
      source: "auto_background",
    })
  })

  test("uses operation timeout for browser, connect, and MCP waits", () => {
    expect(metadata("browser_wait").operationTimeoutMs).toBe(10_000)
    expect(metadata("browser_wait", { timeout: 45_000 }).operationTimeoutMs).toBe(45_000)
    expect(metadata("browser_downloads", { action: "wait" }).operationTimeoutMs).toBe(30_000)
    expect(metadata("connect", { action: "open" }).operationTimeoutMs).toBe(30_000)
    expect(metadata("connect", { action: "list" }).operationTimeoutMs).toBeUndefined()
    expect(metadata("mcp_server_tool", {}, 20_000)).toMatchObject({
      operationTimeoutMs: 20_000,
      displayMs: 20_000,
      source: "wait",
    })
  })

  test("merges durable runtime metadata when tool metadata updates", () => {
    const existing = {
      approval: { status: "not_required" },
      toolTimeout: metadata("glob"),
      display: {
        kind: "media-generation",
        toolCard: "hidden",
        media: { type: "image", pendingTitle: "Generating" },
      },
    }
    expect(ToolTimeout.mergeMetadata(existing, { matches: 1, display: { media: { aspectRatio: "1:1" } } })).toEqual({
      approval: existing.approval,
      matches: 1,
      toolTimeout: existing.toolTimeout,
      display: {
        kind: "media-generation",
        toolCard: "hidden",
        media: { type: "image", pendingTitle: "Generating", aspectRatio: "1:1" },
      },
    })
    expect(ToolTimeout.mergeMetadata(existing, undefined)).toBe(existing)
  })
})
