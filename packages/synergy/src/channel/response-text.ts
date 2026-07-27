import { MessageV2 } from "../session/message-v2"

export function buildAssistantTranscript(parts: ReadonlyMap<string, string>): string {
  return Array.from(parts.values())
    .map((text) => text.trim())
    .filter(Boolean)
    .join("\n\n")
}

export function extractAssistantText(parts: MessageV2.Part[]): string {
  return parts
    .filter((part): part is MessageV2.TextPart => part.type === "text")
    .filter((part) => !MessageV2.isSystemPart(part) && part.text.trim().length > 0)
    .map((part) => part.text)
    .join("\n")
}

export function resolveFinalResponseText(
  transcript: ReadonlyMap<string, string>,
  terminalParts: MessageV2.Part[],
): string {
  return extractAssistantText(terminalParts) || buildAssistantTranscript(transcript)
}
