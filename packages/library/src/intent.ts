import { stripXmlTags, isJunk, isAssistantReasoning, hasToolHallucination, truncate } from "./encoder-sanitize"
import { INTENT_MAX_CHARS, INTENT_MIN_CHARS } from "./encoder-constants"

const TOOL_MARKER_RE = /\[Tool:\s*\w+/g
const LOG_MARKER_RE = /\[Log\]\s+\w+/g

type SanitizeReason = "ok" | "tool-hallucination" | "excessive-tool-output" | "assistant-reasoning" | "junk"

export type SanitizeResult = {
  value: string
  reason: SanitizeReason
}

function clean(raw: string): string {
  return stripXmlTags(raw)
}

function hasExcessiveToolOutput(text: string): boolean {
  const toolMatches = text.match(TOOL_MARKER_RE)
  if (toolMatches && toolMatches.length >= 3) return true
  const logMatches = text.match(LOG_MARKER_RE)
  if (logMatches && logMatches.length >= 3) return true
  return false
}

export namespace Intent {
  function reasonFor(raw: string): SanitizeReason {
    const cleaned = clean(raw)
    if (hasToolHallucination(cleaned)) return "tool-hallucination"
    if (hasExcessiveToolOutput(cleaned)) return "excessive-tool-output"
    if (isAssistantReasoning(cleaned)) return "assistant-reasoning"
    if (isJunk(cleaned, INTENT_MIN_CHARS)) return "junk"
    return "ok"
  }

  export function sanitize(raw: string, fallback: string): string {
    return sanitizeWithReason(raw, fallback).value
  }

  export function sanitizeWithReason(raw: string, fallback: string): SanitizeResult {
    const cleaned = clean(raw)
    const reason = reasonFor(cleaned)
    if (reason === "ok") {
      return {
        value: truncate(cleaned, INTENT_MAX_CHARS),
        reason,
      }
    }

    return {
      value: fallback,
      reason,
    }
  }

  export function isValid(intent: string): boolean {
    const cleaned = clean(intent)
    if (isJunk(cleaned, INTENT_MIN_CHARS)) return false
    if (hasToolHallucination(cleaned)) return false
    if (hasExcessiveToolOutput(cleaned)) return false
    if (isAssistantReasoning(cleaned)) return false
    if (cleaned.length > INTENT_MAX_CHARS) return false
    return true
  }
}
