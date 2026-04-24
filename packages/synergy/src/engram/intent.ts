const MIN_INTENT_LENGTH = 10

const JUNK_PATTERNS = [/^(n\/a|none|null|undefined|unknown|na|nil|empty|\.\.\.|-+|\?+|!+|~+)$/i, /^[^a-zA-Z0-9]+$/]

const XML_TAG_RE = /<[^>]*>/g

const TOOL_HALLUCINATION_RE = /^\[Tool:/m

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

export namespace Intent {
  export function sanitize(raw: string, fallback: string): string {
    const cleaned = clean(raw)
    if (isToolHallucination(cleaned)) return fallback
    return isJunk(cleaned) ? fallback : cleaned
  }

  export function isValid(intent: string): boolean {
    const cleaned = clean(intent)
    return !isJunk(cleaned) && !isToolHallucination(cleaned)
  }
}
