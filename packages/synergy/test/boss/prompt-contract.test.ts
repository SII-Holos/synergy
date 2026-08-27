import { describe, expect, test } from "bun:test"
import type { Info as SessionInfo } from "../../src/session/types"
import {
  BOSS_DISCIPLINE_BLOCK,
  DEFAULT_IDENTITY_TEXT,
  buildBossContext,
  buildBossDeliveryHint,
  buildRuntimeBossContext,
  buildWorkerContext,
} from "../../src/session/boss-prompt"

/**
 * Boss prompt contract (S2a golden). These tests lock the byte-level shape of
 * the boss system-prompt surface before the S2b vertical slice moves the
 * builders into the boss domain. Any diff here must be an explicit product
 * decision, never a refactor side effect.
 */

function bossSession(workflow: Record<string, unknown>): SessionInfo {
  return { id: "s_boss", workflow: { kind: "boss", ...workflow } } as unknown as SessionInfo
}

describe("boss delivery hint golden (auto-delivery matrix)", () => {
  test("auto delivery anchored to a single reply target", () => {
    expect(buildBossDeliveryHint({ auto: true, replyToMessageId: "om_anchor" })).toBe(
      [
        "<boss-delivery>",
        "本轮回复会自动投递回飞书(锚定原消息回复) — 不要调用 channel_push,否则会重复发送。",
        "自动回复锚定消息: om_anchor",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("auto delivery without a resolvable anchor", () => {
    expect(buildBossDeliveryHint({ auto: true })).toBe(
      [
        "<boss-delivery>",
        "本轮回复会自动投递回飞书(锚定原消息回复) — 不要调用 channel_push,否则会重复发送。",
        "</boss-delivery>",
      ].join("\n"),
    )
  })

  test("manual delivery (conflicting anchors or no channel push)", () => {
    expect(buildBossDeliveryHint({ auto: false })).toBe(
      [
        "<boss-delivery>",
        "本轮回复不会自动投递回飞书 — 若需要向用户回执,必须调用 channel_push(可带 chatId / replyToMessageId)。",
        "</boss-delivery>",
      ].join("\n"),
    )
    expect(buildBossDeliveryHint(undefined)).toBe(
      [
        "<boss-delivery>",
        "本轮回复不会自动投递回飞书 — 若需要向用户回执,必须调用 channel_push(可带 chatId / replyToMessageId)。",
        "</boss-delivery>",
      ].join("\n"),
    )
  })
})

describe("boss runtime context golden", () => {
  test("default identity is the colleague persona shipped today", () => {
    expect(DEFAULT_IDENTITY_TEXT).toBe(
      [
        "你是这个 Synergy runtime 的同事(运行时 boss):负责接收外部消息、判断分派对象、协调各项目负责人,并维护对整个 runtime 的认知。",
        "你与各项目 boss 平级协作:用 session_send 派活与接收摘要,用 boss_project 为新项目创建目录、project scope 与项目 boss。",
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
