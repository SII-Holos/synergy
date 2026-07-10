/**
 * Shared encoding-primitive sanitize guards used by both Intent and Script.
 *
 * Both agents run on small models that sometimes produce assistant-style output
 * instead of the requested encoded artifact. These primitives detect the shared
 * failure modes — junk strings, assistant reasoning, and tool-call hallucination.
 *
 * Agent-specific rules (length limits, step counts, etc.) live in their own
 * namespaces (Intent / Script).
 */

const JUNK_PATTERNS = [/^(n\/a|none|null|undefined|unknown|na|nil|empty|\.\.\.|-+|\?+|!+|~+)$/i, /^[^a-zA-Z0-9]+$/]

const ASSISTANT_PREFIX_ZH =
  /^(好的|然后|现在|接下来|我觉得|我认为|我建议|我有一个疑问|不是这个意思|好，|先从|让我|你看|但是|而且|另外|没事|对，|是啊|是这样|嗯，)/
const ASSISTANT_PREFIX_EN =
  /^(I see|I take|I did|I never|I need|I think|I suggest|Let me|You are right|Your proposal|I will|I have|I can|I'll|Sure,|Ok,|Okay,)/i

const TOOL_HALLUCINATION_RE = /^\[Tool:/m
const XML_TAG_RE = /<[^>]*>/g

/**
 * Strip XML/HTML tags from raw model output (e.g. `<intent>...</intent>`).
 */
export function stripXmlTags(raw: string): string {
  return raw.replace(XML_TAG_RE, "").trim()
}

/**
 * Heuristic: model output is junk — too short or only placeholder/symbols.
 * Callers set their own `minLength` to account for agent-specific constraints.
 */
export function isJunk(text: string, minLength: number): boolean {
  if (text.length < minLength) return true
  return JUNK_PATTERNS.some((re) => re.test(text))
}

/**
 * Model produced an assistant-like opening ("I see…", "好的…", "Let me…")
 * instead of the structured artifact it was asked for.
 */
export function isAssistantReasoning(text: string): boolean {
  if (ASSISTANT_PREFIX_ZH.test(text)) return true
  if (ASSISTANT_PREFIX_EN.test(text)) return true
  return false
}

/**
 * Model output starts with `[Tool: …]` on the first line — tool-call syntax
 * leaked into the text generation instead of the encoded artifact.
 */
export function hasToolHallucination(text: string): boolean {
  return TOOL_HALLUCINATION_RE.test(text)
}

/**
 * Smart word-boundary truncation. If a natural break exists in the last 20%,
 * truncate there to avoid mid-word cuts.
 */
export function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(" ")
  if (lastSpace > maxLen * 0.8) return truncated.slice(0, lastSpace)
  return truncated
}
