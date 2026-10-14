import { describe, expect, test } from "bun:test"
import type { Info as SessionInfo } from "@ericsanchezok/synergy-harness/session/types"
import {
  BOSS_DISCIPLINE_BLOCK,
  DEFAULT_IDENTITY_TEXT,
  buildBossContext,
  buildRuntimeBossContext,
  buildWorkerContext,
} from "../../src/boss/boss-prompt"

/**
 * Boss prompt contract (S2a golden). These tests lock the byte-level shape of
 * the boss system-prompt surface before the S2b vertical slice moves the
 * builders into the boss domain. Any diff here must be an explicit product
 * decision, never a refactor side effect.
 */

function bossSession(workflow: Record<string, unknown>): SessionInfo {
  return { id: "s_boss", workflow: { kind: "boss", ...workflow } } as unknown as SessionInfo
}

describe("boss runtime context golden", () => {
  test("default identity is the colleague persona shipped today", () => {
    expect(DEFAULT_IDENTITY_TEXT).toBe(
      [
        "You are a colleague coordinating this Synergy runtime: receive external requests, identify their owners, and maintain a view of ongoing work.",
        "Collaborate with project owners as peers, dispatch work, receive summaries, and establish projects when needed.",
      ].join(" "),
    )
  })

  test("configured identity replaces the persona; structure and separators are exact", () => {
    const context = buildRuntimeBossContext({
      identityText: "IDENTITY_MARKER",
      instructions: "STANDING_INSTRUCTIONS",
    })
    expect(context).toBe(
      [
        buildBossContext(),
        "",
        BOSS_DISCIPLINE_BLOCK,
        "",
        "<boss-persona>\nIDENTITY_MARKER\n</boss-persona>",
        "",
        "Standing instructions from your coordinator:",
        "STANDING_INSTRUCTIONS",
      ].join("\n"),
    )
  })

  test("blank identity falls back to the default persona; blank instructions omit the block", () => {
    const context = buildRuntimeBossContext({ identityText: "   " })
    expect(context).toBe(
      [
        buildBossContext(),
        "",
        BOSS_DISCIPLINE_BLOCK,
        "",
        `<boss-persona>\n${DEFAULT_IDENTITY_TEXT}\n</boss-persona>`,
      ].join("\n"),
    )
    expect(context).not.toContain("Standing instructions")
  })

  test("report style renders as a dedicated block between persona and instructions", () => {
    const context = buildRuntimeBossContext({
      identityText: "IDENTITY_MARKER",
      reportStyle: "REPORT_STYLE_MARKER",
      instructions: "STANDING_INSTRUCTIONS",
    })
    expect(context).toBe(
      [
        buildBossContext(),
        "",
        BOSS_DISCIPLINE_BLOCK,
        "",
        "<boss-persona>\nIDENTITY_MARKER\n</boss-persona>",
        "",
        "<boss-report-style>\nREPORT_STYLE_MARKER\n</boss-report-style>",
        "",
        "Standing instructions from your coordinator:",
        "STANDING_INSTRUCTIONS",
      ].join("\n"),
    )
  })

  test("absent report style omits the report-style block entirely", () => {
    const context = buildRuntimeBossContext({ identityText: "IDENTITY_MARKER" })
    expect(context).not.toContain("<boss-report-style>")
  })

  test("boss context block is byte-exact", () => {
    expect(buildBossContext()).toBe(
      [
        "<boss-context>",
        "You are the boss of a Boss Mode worker tree — the human's only interface to the tree.",
        "You decide, delegate, monitor, and summarize.",
        "Answer simple requests directly when they do not need a worker; delegate substantive execution to specialist workers and summarize their verified reports for the human.",
        "When a worker reports, decide the next step from the report. When a decision belongs to the human, ask the human — do not guess on their behalf.",
        "</boss-context>",
      ].join("\n"),
    )
  })
})

describe("boss worker context golden", () => {
  test("worker context names role, root, report contract, and instructions exactly", () => {
    const session = bossSession({
      role: "worker",
      workerRole: "research",
      rootID: "s_root",
      instructions: "INSTR_MARKER",
    })
    expect(buildWorkerContext(session)).toBe(
      [
        "<boss-worker-context>",
        "You are a research specialist worker in a Boss Mode worker tree rooted at session s_root.",
        "Complete each assigned task and formally report the outcome to your parent through boss_report. Distinguish completion, blockers, and decisions needing input.",
        "When child workers report to you, handle their reports or summarize them upward to your parent.",
        "You do not contact the human directly.",
        "",
        "Standing instructions from your boss:",
        "INSTR_MARKER",
        "</boss-worker-context>",
      ].join("\n"),
    )
  })

  test("worker defaults: general role, session root, no instructions block", () => {
    const session = bossSession({ role: "worker" })
    expect(buildWorkerContext(session)).toContain(
      "You are a general specialist worker in a Boss Mode worker tree rooted at session s_boss.",
    )
    expect(buildWorkerContext(session)).not.toContain("Standing instructions")
  })
})
