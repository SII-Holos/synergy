const PREAMBLE_HEADING = "## Preamble Messages"

export function buildPreambleSection(): string {
  return [
    PREAMBLE_HEADING,
    "",
    "Before using tools, send one brief sentence telling the user what you are about to do.",
    "Group related reads, searches, edits, commands, or external calls under a single preamble instead of narrating every individual tool call.",
    "",
    "Keep preambles concise, concrete, and forward-looking:",
    "- Say the immediate next action.",
    "- Mention relevant prior progress when it helps.",
    "- Use one sentence by default.",
    "- Keep the tone direct and collaborative.",
  ].join("\n")
}

export function withPreambleSection(prompt?: string): string {
  const trimmed = prompt?.trim()
  if (trimmed?.includes(PREAMBLE_HEADING)) return trimmed
  return [trimmed, buildPreambleSection()].filter(Boolean).join("\n\n")
}
