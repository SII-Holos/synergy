import type { Prompt } from "@/context/prompt"
import { sanitizePromptValue } from "@/context/prompt/sanitize"
import { InputAssistance } from "@ericsanchezok/synergy-util/input-assistance"

export type PromptHistoryEntry = { prompt: Prompt; assistance?: InputAssistance.Info }
const sanitizePrompt = (value: unknown) => sanitizePromptValue(value) as unknown as Prompt

export function sanitizePromptHistory(value: unknown) {
  const entries = typeof value === "object" && value !== null && "entries" in value ? value.entries : undefined
  return {
    version: 2,
    entries: Array.isArray(entries)
      ? entries.map((entry): PromptHistoryEntry => {
          if (Array.isArray(entry)) return { prompt: sanitizePrompt(entry) }
          if (typeof entry !== "object" || entry === null) return { prompt: sanitizePrompt([]) }
          return { prompt: sanitizePrompt(entry.prompt), assistance: InputAssistance.read(entry) }
        })
      : [],
  }
}
