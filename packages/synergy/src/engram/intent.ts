const MIN_INTENT_LENGTH = 10
const MAX_INTENT_LENGTH = 300

const JUNK_PATTERNS = [/^(n\/a|none|null|undefined|unknown|na|nil|empty|\.\.\.|-+|\?+|!+|~+)$/i, /^[^a-zA-Z0-9]+$/]

const XML_TAG_RE = /<[^>]*>/g

const TOOL_HALLUCINATION_RE = /^\[Tool:/m
const TOOL_MARKER_RE = /\[Tool:\s*\w+/g
const LOG_MARKER_RE = /\[Log\]\s+\w+/g

function clean(raw: string): string {
  return raw.trim().replace(XML_TAG_RE, "").trim()
}

function isJunk(text: string): boolean {
  if (text.length < MIN_INTENT_LENGTH) return true
  return JUNK_PATTERNS.some((re) => re.test(text))
}

function isToolHallucination(text: string): boolean {
  return TOOL_HALLUCINATION_RE.test(text)
}

function hasExcessiveToolOutput(text: string): boolean {
  const toolMatches = text.match(TOOL_MARKER_RE)
  if (toolMatches && toolMatches.length >= 3) return true
  const logMatches = text.match(LOG_MARKER_RE)
  if (logMatches && logMatches.length >= 3) return true
  return false
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(" ")
  if (lastSpace > maxLen * 0.8) return truncated.slice(0, lastSpace)
  return truncated
}

export namespace Intent {
  export function sanitize(raw: string, fallback: string): string {
    const cleaned = clean(raw)
    if (isToolHallucination(cleaned)) return fallback
    if (hasExcessiveToolOutput(cleaned)) return fallback
    if (isJunk(cleaned)) return fallback
    return truncate(cleaned, MAX_INTENT_LENGTH)
  }

  export function isValid(intent: string): boolean {
    const cleaned = clean(intent)
    if (isJunk(cleaned)) return false
    if (isToolHallucination(cleaned)) return false
    if (hasExcessiveToolOutput(cleaned)) return false
    if (cleaned.length > MAX_INTENT_LENGTH) return false
    return true
  }
}
