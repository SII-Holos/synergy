import { describe, expect, test } from "bun:test"
import type { ToolMetadata } from "../src/components/tool-registry-lazy"
import { toolCountdown } from "../src/components/tool/timeout"

// Stored parts may carry arbitrary historical metadata shapes; the helper
// bypasses the shared type so the runtime defenses stay exercised.
const md = (toolTimeout: unknown): ToolMetadata => ({ toolTimeout }) as ToolMetadata

describe("tool timeout helper", () => {
  test("requires a real server anchor before it renders a countdown", () => {
    expect(toolCountdown(md({ displayMs: 15_000 }), { start: 1_000 })).toEqual({
      seconds: 15,
      startedAt: 1_000,
      kind: "remaining",
    })
    expect(toolCountdown(md({ displayMs: 15_000 }), {})).toBeUndefined()
    expect(toolCountdown(md({ displayMs: 15_000 }), undefined)).toBeUndefined()
  })

  test("maps the timeout source onto the countdown kind", () => {
    expect(toolCountdown(md({ displayMs: 30_000, source: "auto_background" }), { start: 1 })?.kind).toBe(
      "auto_background",
    )
    expect(toolCountdown(md({ displayMs: 30_000, source: "tool_timeout" }), { start: 1 })?.kind).toBe("timeout")
    for (const source of [
      "wait",
      "search",
      "fetch",
      "download",
      "question",
      "vision",
      "remote_connect",
      "document_extract",
    ]) {
      expect(toolCountdown(md({ displayMs: 30_000, source }), { start: 1 })?.kind).toBe("remaining")
    }
  })

  test("falls back to remaining for missing or unknown sources", () => {
    expect(toolCountdown(md({ displayMs: 30_000 }), { start: 1 })?.kind).toBe("remaining")
    expect(toolCountdown(md({ displayMs: 30_000, source: "future_kind" }), { start: 1 })?.kind).toBe("remaining")
  })

  test("keeps countdown anchored to a real tool start time", () => {
    const result = toolCountdown(md({ displayMs: 300_000 }), { start: 123_456 })
    expect(result).toEqual({ seconds: 300, startedAt: 123_456, kind: "remaining" })
  })

  test("does not show countdown without a valid display timeout", () => {
    expect(toolCountdown({}, { start: 1 })).toBeUndefined()
    expect(toolCountdown(md({ displayMs: 0 }), { start: 1 })).toBeUndefined()
    expect(toolCountdown(md({ displayMs: "300000" }), { start: 1 })).toBeUndefined()
  })
})
