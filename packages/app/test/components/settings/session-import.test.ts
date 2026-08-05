import { describe, expect, test } from "bun:test"
import {
  BUILTIN_SETTINGS_IDS,
  BUILTIN_SETTINGS_SECTIONS,
  getBuiltinSettingsSection,
} from "../../../src/components/settings/catalog"
import type { ForeignImportJobState } from "@ericsanchezok/synergy-sdk/client"
import { jobPercent } from "../../../src/components/settings/panels/session-import-model"

function job(completedCount: number, totalCount = 10): ForeignImportJobState {
  return {
    id: "job-1",
    source: "claude-code",
    status: "running",
    totalCount,
    completedCount,
    okCount: completedCount,
    failedCount: 0,
    startedAt: 1,
    completedAt: null,
    error: null,
    items: [],
  }
}

describe("settings catalog session-import section", () => {
  test("registers session-import in the system group between config-files and archived-sessions", () => {
    expect(BUILTIN_SETTINGS_IDS).toContain("session-import")
    const section = getBuiltinSettingsSection("session-import")!
    expect(section.groupKey).toBe("system")
    expect(section.label).toBe("Session Import")
    expect(section.description).toContain("Claude Code")
    expect(section.order).toBe(25)

    const configFiles = getBuiltinSettingsSection("config-files")!
    const archived = getBuiltinSettingsSection("archived-sessions")!
    expect(section.order).toBeGreaterThan(configFiles.order)
    expect(section.order).toBeLessThan(archived.order)
  })

  test("search keywords cover claude, codex, transcript, and history", () => {
    const section = getBuiltinSettingsSection("session-import")!
    expect(section.keywords).toContain("claude")
    expect(section.keywords).toContain("codex")
    expect(section.keywords).toContain("transcript")
    expect(section.keywords).toContain("history")
  })

  test("built-in sections remain ordered consistently with ids", () => {
    expect(BUILTIN_SETTINGS_SECTIONS.map((section) => section.id)).toEqual([...BUILTIN_SETTINGS_IDS])
  })
})

describe("session import progress model", () => {
  test("computes the meter percentage from completed and total counts", () => {
    expect(jobPercent(job(0))).toBe(0)
    expect(jobPercent(job(5))).toBe(50)
    expect(jobPercent(job(10))).toBe(100)
  })

  test("handles empty and over-complete counts safely", () => {
    expect(jobPercent(job(0, 0))).toBe(0)
    expect(jobPercent(job(11))).toBe(100)
  })
})
