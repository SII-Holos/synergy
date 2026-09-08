import { stripXmlTags, isJunk, isAssistantReasoning, hasToolHallucination } from "./encoder-sanitize"
import { SCRIPT_MIN_CHARS, SCRIPT_MIN_STEPS } from "./encoder-constants"

type SanitizeReason = "ok" | "tool-hallucination" | "assistant-reasoning" | "junk" | "no-steps" | "too-few-steps"

export type SanitizeResult = {
  value: string
  reason: SanitizeReason
}

/** Detects whether any line starts with a numbered-step marker (e.g. `"1. Step"`). */
const STEP_LINE_RE = /^\d+\.\s/m

function countSteps(text: string): number {
  const matches = text.match(/^\d+\./gm)
  return matches ? matches.length : 0
}

export namespace Script {
  function reasonFor(raw: string): SanitizeReason {
    const cleaned = stripXmlTags(raw)
    if (!cleaned) return "junk"
    if (hasToolHallucination(cleaned)) return "tool-hallucination"
    if (isAssistantReasoning(cleaned)) return "assistant-reasoning"
    if (isJunk(cleaned, 3)) return "junk"
    if (!STEP_LINE_RE.test(cleaned)) return "no-steps"
    if (countSteps(cleaned) < SCRIPT_MIN_STEPS) return "too-few-steps"
    if (isJunk(cleaned, SCRIPT_MIN_CHARS)) return "junk"
    return "ok"
  }

  export function sanitize(raw: string, fallback: string): string {
    return sanitizeWithReason(raw, fallback).value
  }

  export function sanitizeWithReason(raw: string, fallback: string): SanitizeResult {
    const reason = reasonFor(raw)
    if (reason === "ok") return { value: raw.trim(), reason }
    return { value: fallback, reason }
  }
}
