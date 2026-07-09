import { describe, expect, test } from "bun:test"
import { formatHealthSnapshot, formatLogTail } from "../../src/cli/cmd/plugin-dev"
import type { HealthSnapshot } from "../../src/cli/cmd/plugin-dev"
import type { PluginLogEntry } from "../../src/plugin-runtime/logs"

// ---------------------------------------------------------------------------
// Health snapshot formatter
// ---------------------------------------------------------------------------

describe("formatHealthSnapshot", () => {
  test("renders all fields for a running process-mode plugin", () => {
    const snapshot: HealthSnapshot = {
      mode: "process",
      pid: 12345,
      state: "ready",
      memoryMb: 48,
      lastHeartbeatAt: Date.now() - 2000,
      activeRequests: 2,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/Mode:\s+process/)
    expect(joined).toMatch(/PID:\s+12345/)
    expect(joined).toMatch(/State:\s+ready/)
    expect(joined).toMatch(/Memory:\s+48 MB/)
    expect(joined).toMatch(/Heartbeat:\s+\d+s ago/)
    expect(joined).toMatch(/Requests:\s+2 active/)
    expect(joined).toMatch(/Logs:\s+0 dropped/)
  })

  test("renders minimal snapshot without optional fields", () => {
    const snapshot: HealthSnapshot = {
      mode: "in-process",
      state: "ready",
      activeRequests: 0,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/Mode:\s+in-process/)
    expect(joined).toMatch(/State:\s+ready/)
    expect(joined).not.toMatch(/PID:/)
    expect(joined).not.toMatch(/Memory:/)
    expect(joined).not.toMatch(/Heartbeat:/)
  })

  test("shows unhealthy state with dropped logs", () => {
    const snapshot: HealthSnapshot = {
      mode: "process",
      pid: 9999,
      state: "unhealthy",
      memoryMb: 300,
      activeRequests: 5,
      droppedLogs: 42,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/State:\s+unhealthy/)
    expect(joined).toMatch(/Memory:\s+300 MB/)
    expect(joined).toMatch(/Logs:\s+42 dropped/)
    expect(joined).toMatch(/Requests:\s+5 active/)
  })

  test("shows heartbeat time ago", () => {
    const now = Date.now()
    const snapshot: HealthSnapshot = {
      mode: "worker",
      state: "ready",
      lastHeartbeatAt: now - 5000,
      activeRequests: 1,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/Heartbeat:\s+\d+s ago/)
  })

  test("handles crashed state", () => {
    const snapshot: HealthSnapshot = {
      mode: "process",
      state: "crashed",
      activeRequests: 0,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/State:\s+crashed/)
    expect(joined).not.toMatch(/undefined/)
  })

  test("handles starting state", () => {
    const snapshot: HealthSnapshot = {
      mode: "worker",
      pid: 100,
      state: "starting",
      activeRequests: 0,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/State:\s+starting/)
    expect(joined).toMatch(/PID:\s+100/)
  })

  test("handles stopped state without pid", () => {
    const snapshot: HealthSnapshot = {
      mode: "in-process",
      state: "stopped",
      activeRequests: 0,
      droppedLogs: 0,
    }
    const result = formatHealthSnapshot(snapshot)
    const joined = result.join("\n")
    expect(joined).toMatch(/State:\s+stopped/)
    expect(joined).not.toMatch(/undefined/)
  })
})

// ---------------------------------------------------------------------------
// Log tail formatter
// ---------------------------------------------------------------------------

describe("formatLogTail", () => {
  test("returns empty array when no entries", () => {
    expect(formatLogTail([])).toEqual([])
  })

  test("formats log entries with level and message", () => {
    const entries: PluginLogEntry[] = [
      { timestamp: Date.now(), level: "info", message: "plugin started" },
      { timestamp: Date.now(), level: "warn", message: "slow request" },
    ]
    const result = formatLogTail(entries)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatch(/info/)
    expect(result[0]).toMatch(/plugin started/)
    expect(result[1]).toMatch(/warn/)
    expect(result[1]).toMatch(/slow request/)
  })

  test("includes timestamp in each formatted line", () => {
    const entries: PluginLogEntry[] = [{ timestamp: Date.now(), level: "debug", message: "test message" }]
    const result = formatLogTail(entries)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/\d{2}:\d{2}:\d{2}/)
  })

  test("truncates to maxLines", () => {
    const entries: PluginLogEntry[] = Array.from({ length: 10 }, (_, i) => ({
      timestamp: Date.now() + i * 1000,
      level: "info",
      message: `msg ${i}`,
    }))
    const result = formatLogTail(entries, 3)
    expect(result).toHaveLength(3)
  })

  test("default maxLines is 10", () => {
    const entries: PluginLogEntry[] = Array.from({ length: 20 }, (_, i) => ({
      timestamp: Date.now() + i * 1000,
      level: "info",
      message: `msg ${i}`,
    }))
    const result = formatLogTail(entries)
    expect(result).toHaveLength(10)
  })

  test("shows most recent entries when truncated (tail behavior)", () => {
    const entries: PluginLogEntry[] = Array.from({ length: 5 }, (_, i) => ({
      timestamp: Date.now() + i * 1000,
      level: "info",
      message: `msg ${i}`,
    }))
    const result = formatLogTail(entries, 2)
    expect(result).toHaveLength(2)
    expect(result[0]).toMatch(/msg 3/)
    expect(result[1]).toMatch(/msg 4/)
  })

  test("handles error-level entries", () => {
    const entries: PluginLogEntry[] = [{ timestamp: Date.now(), level: "error", message: "something broke" }]
    const result = formatLogTail(entries)
    expect(result).toHaveLength(1)
    expect(result[0]).toMatch(/error/)
    expect(result[0]).toMatch(/something broke/)
  })
})
