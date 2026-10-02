import { PROGRESS_UPDATES } from "./progress"

const PREAMBLE_HEADING = "## Preamble Messages"
const PROGRESS_HEADING = PROGRESS_UPDATES.split("\n")[0]

export function buildPreambleSection(): string {
  return PROGRESS_UPDATES
}

export function withPreambleSection(prompt?: string): string {
  const trimmed = prompt?.trim()
  if (trimmed?.includes(PROGRESS_HEADING) || trimmed?.includes(PREAMBLE_HEADING)) return trimmed
  return [trimmed, buildPreambleSection()].filter(Boolean).join("\n\n")
}
