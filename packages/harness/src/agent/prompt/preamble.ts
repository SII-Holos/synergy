const PREAMBLE_HEADING = "## Preamble Messages"

export function buildPreambleSection(): string {
  return [
    PREAMBLE_HEADING,
    "",
    "Tool calls are already visible as they happen, so do not narrate every read, search, edit, or command.",
    "",
    "Send a short message only when it helps the user follow along:",
    "- Starting a multi-step task: one sentence on the plan.",
    "- Key decisions: what you are choosing and why.",
    "- Unexpected findings or risks: what differs from expectations.",
    "- Completion: the outcome and anything still uncertain.",
    "",
    "Keep each message concise, concrete, and forward-looking — one sentence by default.",
  ].join("\n")
}

export function withPreambleSection(prompt?: string): string {
  const trimmed = prompt?.trim()
  if (trimmed?.includes(PREAMBLE_HEADING)) return trimmed
  return [trimmed, buildPreambleSection()].filter(Boolean).join("\n\n")
}
