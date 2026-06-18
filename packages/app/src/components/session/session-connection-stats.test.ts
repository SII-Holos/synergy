import { describe, expect, test } from "bun:test"
import {
  computeCortexStats,
  computeLspStats,
  computeMcpStats,
  type CortexStats,
  type LspStats,
  type McpStats,
} from "./session-connection-stats"
import type { CortexTask, LspStatus, McpStatus } from "@ericsanchezok/synergy-sdk/client"

// --- LSP ---

function lsp(name: string, status: LspStatus["status"]): LspStatus {
  return { id: name, name, root: "/", status }
}

describe("computeLspStats", () => {
  test("undefined input returns zeros", () => {
    expect(computeLspStats(undefined)).toEqual({ connected: 0, hasError: false, total: 0 } satisfies LspStats)
  })

  test("empty array returns zeros", () => {
    expect(computeLspStats([])).toEqual({ connected: 0, hasError: false, total: 0 } satisfies LspStats)
  })

  test("counts connected servers", () => {
    expect(computeLspStats([lsp("ts", "connected"), lsp("lua", "connected")])).toEqual({
      connected: 2,
      hasError: false,
      total: 2,
    } satisfies LspStats)
  })

  test("detects errors independently of connected count", () => {
    expect(computeLspStats([lsp("ts", "connected"), lsp("rust", "error")])).toEqual({
      connected: 1,
      hasError: true,
      total: 2,
    } satisfies LspStats)
  })

  test("all errors still reports connected zero", () => {
    expect(computeLspStats([lsp("a", "error"), lsp("b", "error")])).toEqual({
      connected: 0,
      hasError: true,
      total: 2,
    } satisfies LspStats)
  })
})

// --- MCP ---

function mcp(status: McpStatus["status"]): McpStatus {
  switch (status) {
    case "failed":
      return { status, error: "boom" }
    case "reconnecting":
      return { status, attempt: 1, maxAttempts: 3 }
    case "needs_client_registration":
      return { status, error: "register" }
    default:
      return { status }
  }
}

describe("computeMcpStats", () => {
  test("undefined input returns zeros", () => {
    expect(computeMcpStats(undefined)).toEqual({ enabled: 0, failed: false, total: 0 } satisfies McpStats)
  })

  test("empty record returns zeros", () => {
    expect(computeMcpStats({})).toEqual({ enabled: 0, failed: false, total: 0 } satisfies McpStats)
  })

  test("counts only connected servers", () => {
    expect(computeMcpStats({ a: mcp("connected"), b: mcp("connected"), c: mcp("starting") })).toEqual({
      enabled: 2,
      failed: false,
      total: 3,
    } satisfies McpStats)
  })

  test("detects any failed server", () => {
    expect(computeMcpStats({ a: mcp("connected"), b: mcp("failed") })).toEqual({
      enabled: 1,
      failed: true,
      total: 2,
    } satisfies McpStats)
  })
})

// --- Cortex ---

function cortex(sessionID: string, status: CortexTask["status"]): CortexTask {
  return {
    id: "t1",
    sessionID,
    parentSessionID: sessionID,
    parentMessageID: "m1",
    description: "task",
    prompt: "p",
    agent: "a",
    status,
    startedAt: 0,
  }
}

describe("computeCortexStats", () => {
  test("undefined tasks returns zeros", () => {
    expect(computeCortexStats(undefined, "s1")).toEqual({
      active: 0,
      completed: 0,
      hasRunning: false,
    } satisfies CortexStats)
  })

  test("only counts tasks matching sessionID", () => {
    expect(computeCortexStats([cortex("s1", "running"), cortex("s2", "running")], "s1")).toEqual({
      active: 1,
      completed: 0,
      hasRunning: true,
    } satisfies CortexStats)
  })

  test("running and queued count as active", () => {
    expect(
      computeCortexStats([cortex("s1", "running"), cortex("s1", "queued"), cortex("s1", "pending")], "s1"),
    ).toEqual({
      active: 2,
      completed: 0,
      hasRunning: true,
    } satisfies CortexStats)
  })

  test("completed and error count as completed", () => {
    expect(
      computeCortexStats([cortex("s1", "completed"), cortex("s1", "error"), cortex("s1", "cancelled")], "s1"),
    ).toEqual({
      active: 0,
      completed: 2,
      hasRunning: false,
    } satisfies CortexStats)
  })
})
