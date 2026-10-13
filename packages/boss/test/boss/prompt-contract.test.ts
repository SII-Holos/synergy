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
        "你是这个 Synergy runtime 的同事(运行时 boss):负责接收外部消息、判断分派对象、协调各项目负责人,并维护对整个 runtime 的认知。",
        "你与各项目负责人平级协作，派发工作、接收摘要，并在需要时建立新项目。",
      ].join(" "),
    )
  })

  test("configured identity replaces the persona; structure and separators are exact", () => {
    const session = bossSession({ role: "boss" })
    const context = buildRuntimeBossContext(session, {
      identityText: "IDENTITY_MARKER",
      instructions: "STANDING_INSTRUCTIONS",
    })
    expect(context).toBe(
      [
        buildBossContext(session),
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
    const session = bossSession({ role: "boss" })
    const context = buildRuntimeBossContext(session, { identityText: "   " })
    expect(context).toBe(
      [
        buildBossContext(session),
        "",
        BOSS_DISCIPLINE_BLOCK,
        "",
        `<boss-persona>\n${DEFAULT_IDENTITY_TEXT}\n</boss-persona>`,
      ].join("\n"),
    )
    expect(context).not.toContain("Standing instructions")
  })

  test("report style renders as a dedicated block between persona and instructions", () => {
    const session = bossSession({ role: "boss" })
    const context = buildRuntimeBossContext(session, {
      identityText: "IDENTITY_MARKER",
      reportStyle: "REPORT_STYLE_MARKER",
      instructions: "STANDING_INSTRUCTIONS",
    })
    expect(context).toBe(
      [
        buildBossContext(session),
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
    const session = bossSession({ role: "boss" })
    const context = buildRuntimeBossContext(session, { identityText: "IDENTITY_MARKER" })
    expect(context).not.toContain("<boss-report-style>")
  })

  test("boss context block is byte-exact", () => {
    expect(buildBossContext(bossSession({ role: "boss" }))).toBe(
      [
        "<boss-context>",
        "You are the boss of a Boss Mode worker tree — the human's only interface to the tree.",
        "You decide, delegate, monitor, and summarize. Use boss_spawn to create specialist workers, boss_assign to hand them tasks, boss_status to monitor the tree, and boss_cancel to stop work.",
        "Answer simple requests directly when they do not need a worker; delegate substantive execution to specialist workers and summarize their boss_report reports for the human.",
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
        "Tasks are dispatched to you through your inbox. Complete each assigned task, then call boss_report with a summary and status.",
        'Use status "completed" when done, "blocked" when you are stuck, and "needs_input" when you need a decision.',
        "When child workers report to you, handle their reports or summarize them upward to your parent.",
        "You do not contact the human directly — report to your parent with boss_report.",
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
