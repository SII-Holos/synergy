import type { FilePart } from "@ericsanchezok/synergy-sdk/client"

type MaybeToolPart = {
  type?: string
  state?: {
    status?: string
    metadata?: Record<string, any>
    attachments?: FilePart[]
  }
}

export type ToolResultPresentation = "default" | "artifact-only"

function displayMetadata(part: MaybeToolPart): Record<string, any> | undefined {
  const metadata = part.state?.metadata
  const display = metadata?.display
  return display && typeof display === "object" && !Array.isArray(display) ? display : undefined
}

export function toolResultPresentation(part: unknown): ToolResultPresentation {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return "default"
  return displayMetadata(candidate)?.presentation === "artifact-only" ? "artifact-only" : "default"
}

export function isArtifactOnlyToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (candidate.state?.status !== "completed") return false
  if (toolResultPresentation(candidate) !== "artifact-only") return false
  return (candidate.state.attachments?.length ?? 0) > 0
}

export function primaryToolAttachments(part: unknown): FilePart[] {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool" || candidate.state?.status !== "completed") return []

  const attachments = candidate.state.attachments ?? []
  if (attachments.length === 0) return []

  const metadata = candidate.state.metadata ?? {}
  const display = displayMetadata(candidate)
  const rawIds = display?.primaryAttachmentIds ?? metadata.primaryAttachmentIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) return attachments

  const ids = new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))
  if (ids.size === 0) return attachments

  const selected = attachments.filter((attachment) => ids.has(attachment.id))
  return selected.length > 0 ? selected : attachments
}
