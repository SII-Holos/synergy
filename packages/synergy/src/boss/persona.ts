import { Config } from "../config/config"
import { BossIdentity } from "./identity"
import { DEFAULT_IDENTITY_TEXT } from "./boss-prompt"

/**
 * Deterministic runtime-boss persona rendering (R2 / R7).
 *
 * `experimental.boss_persona` selects a built-in colleague personality
 * (project_manager / ops_assistant) or a custom four-trait blend. Rendering is
 * a pure function over config + the boss name row: no LLM calls, no extra
 * storage. `experimental.boss_identity_text` (legacy free-form identity) is
 * used only when no persona preset is configured; when neither is set the
 * neutral colleague identity (`DEFAULT_IDENTITY_TEXT`) is used so an upgrade
 * never produces a blank persona.
 */
export type BossPersonaPreset = "project_manager" | "ops_assistant"

export type BossPersonaConfig =
  | { preset: "project_manager" }
  | { preset: "ops_assistant" }
  | { preset: "custom"; formality: number; conciseness: number; proactiveness: number; warmth: number }

export interface RenderBossPersonaInput {
  /** `experimental.boss_persona` (config). */
  persona?: BossPersonaConfig
  /** `experimental.boss_identity_text` (legacy); used only when `persona` is unset. */
  legacyIdentityText?: string
  /** Boss name from the shared self memory (`boss_name`); rendered when present. */
  name?: string
}

export interface RenderedBossPersona {
  /** Identity / voice text for the `<boss-persona>` block. */
  identityText: string
  /** Concise, human-like reporting directives for the `<boss-report-style>` block. */
  reportStyle: string
}

/** Neutral reporting style shared by every persona. channel_push is the only outbound path (R6). */
export const BASE_REPORT_STYLE = [
  "你通过显式 channel_push 向用户回传消息;每次回传都像一位人类同事在汇报——精简、有效、有条理:",
  "- 只汇报结论、当前进展、需要的决策与下一步;不倾倒中间过程、工具细节或冗长原文。",
  "- 先给结论,再给必要的要点;能用一两句话说清就不用列表。",
  "- 用自然、直接的语言,不用系统腔;风险与建议要明说。",
].join("\n")

const PROJECT_MANAGER_CHARACTER = [
  "你是一位高效的项目经理型同事:行动导向、推进清晰、说话干脆,习惯先结论后细节,主动盯进度与风险。",
].join("\n")

const PROJECT_MANAGER_STYLE = [
  "汇报像项目经理:先一句话结论并标注状态(完成/进行中/阻塞),再列 2-4 条要点说明进展、结果与需要用户决策的事项;涉及会话与任务时给出准确 ID。",
].join("\n")

const OPS_ASSISTANT_CHARACTER = [
  "你是一位贴心的运营助理型同事:温和可靠、细致周到,把用户的体验放在心上;给建议时习惯提供可选项,而不是替用户拍板。",
].join("\n")

const OPS_ASSISTANT_STYLE = [
  "汇报像贴心的运营助理:语气友好自然,先说明结果,再补一句下一步建议;遇到有多种做法的场景,给用户 2-3 个选项并说明取舍。",
].join("\n")

const CUSTOM_CHARACTER = ["你是一位按照用户偏好打磨风格的同事:在不同任务里保持稳定、可靠、条理清晰。"].join("\n")

type TraitLevel = "low" | "mid" | "high"

function traitLevel(value: number): TraitLevel {
  if (value >= 0.6) return "high"
  if (value <= 0.4) return "low"
  return "mid"
}

const FORMALITY_TEXT: Record<TraitLevel, string | undefined> = {
  low: "语气轻松随意,像熟识的同事闲聊;",
  mid: undefined,
  high: "用词正式、结构清晰,避免口语化与表情符号;",
}

const CONCISENESS_TEXT: Record<TraitLevel, string | undefined> = {
  low: "可以适当展开背景与理由,不必刻意压缩;",
  mid: undefined,
  high: "尽量精简:单条回传通常不超过五行,内容较多时改用要点;",
}

const PROACTIVENESS_TEXT: Record<TraitLevel, string | undefined> = {
  low: "以回应用户为主,不主动扩展任务或额外建议;",
  mid: undefined,
  high: "除完成请求外,主动指出下一步、风险与可顺手推进的事项;",
}

const WARMTH_TEXT: Record<TraitLevel, string | undefined> = {
  low: "保持中立克制,不过度渲染情绪;",
  mid: undefined,
  high: "语气温暖,适时表达共情,可少量使用表情符号拉近距离;",
}

/**
 * Render the boss persona to the two per-turn prompt blocks. Pure and
 * deterministic: same input always yields the same text (unit-tested).
 */
export function renderBossPersona(input: RenderBossPersonaInput): RenderedBossPersona {
  const persona = input.persona
  const name = input.name?.trim()
  const reportExtras: string[] = []

  let identityBody: string
  if (!persona) {
    // Legacy free-form identity or the neutral colleague default.
    identityBody = input.legacyIdentityText?.trim() || DEFAULT_IDENTITY_TEXT
  } else if (persona.preset === "project_manager") {
    identityBody = [PROJECT_MANAGER_CHARACTER, DEFAULT_IDENTITY_TEXT].join("\n")
    reportExtras.push(PROJECT_MANAGER_STYLE)
  } else if (persona.preset === "ops_assistant") {
    identityBody = [OPS_ASSISTANT_CHARACTER, DEFAULT_IDENTITY_TEXT].join("\n")
    reportExtras.push(OPS_ASSISTANT_STYLE)
  } else {
    identityBody = [CUSTOM_CHARACTER, DEFAULT_IDENTITY_TEXT].join("\n")
    const traits = [
      FORMALITY_TEXT[traitLevel(persona.formality)],
      CONCISENESS_TEXT[traitLevel(persona.conciseness)],
      PROACTIVENESS_TEXT[traitLevel(persona.proactiveness)],
      WARMTH_TEXT[traitLevel(persona.warmth)],
    ].filter((text): text is string => Boolean(text))
    if (traits.length > 0) reportExtras.push(`你的汇报风格:${traits.join("")}`)
  }

  const identityLines = [...(name ? [`你是用户的同事,名字叫「${name}」。`] : []), identityBody]

  return {
    identityText: identityLines.join("\n"),
    reportStyle: [BASE_REPORT_STYLE, ...reportExtras].join("\n\n"),
  }
}

/**
 * Resolve the effective boss persona from the live config + the boss name
 * memory row. Async because it reads the shared config; the pure rendering
 * itself is `renderBossPersona`. Shared by the per-turn prompt builder
 * (register.ts) and the world-overview briefing (boss-runtime.ts) so both
 * surfaces always present the same colleague.
 */
export async function resolveBossPersona(): Promise<RenderedBossPersona> {
  const config = await Config.current().catch(() => undefined)
  const experimental = config?.experimental
  return renderBossPersona({
    persona: experimental?.boss_persona ?? undefined,
    legacyIdentityText: experimental?.boss_identity_text?.trim() || undefined,
    name: BossIdentity.getBossName(),
  })
}
