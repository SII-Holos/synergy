import type { FilePart } from "@ericsanchezok/synergy-sdk/client"

type MaybeToolPart = {
  tool?: string
  type?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, any>
    attachments?: FilePart[]
  }
}

export type ToolResultPresentation = "default" | "artifact-only"
export type ToolDisplayKind = "default" | "media-generation"
export type ToolVisibility = "default" | "media" | "hidden-unless-error"
export type ToolMediaType = "image" | "video" | "audio"

export interface ToolMediaDisplay {
  type?: ToolMediaType
  actionLabel?: string
  pendingTitle?: string
  pendingDescription?: string
  promptField?: string
  aspectRatio?: "1:1" | "4:3" | "16:9" | "auto"
}

export interface ToolDisplayMetadata {
  kind?: ToolDisplayKind
  visibility?: ToolVisibility
  presentation?: ToolResultPresentation
  media?: ToolMediaDisplay
  primaryAttachmentIds?: string[]
}

export function toolDisplayMetadata(part: unknown): ToolDisplayMetadata | undefined {
  const candidate = part as MaybeToolPart
  const metadata = candidate.state?.metadata
  const display = metadata?.display
  return display && typeof display === "object" && !Array.isArray(display)
    ? (display as ToolDisplayMetadata)
    : undefined
}

export function toolResultPresentation(part: unknown): ToolResultPresentation {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return "default"
  return toolDisplayMetadata(candidate)?.presentation === "artifact-only" ? "artifact-only" : "default"
}

export function isMediaGenerationToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  const display = toolDisplayMetadata(candidate)
  return display?.kind === "media-generation" || display?.visibility === "media"
}

export function isArtifactOnlyToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (candidate.state?.status !== "completed") return false
  if (toolResultPresentation(candidate) !== "artifact-only") return false
  return (candidate.state.attachments?.length ?? 0) > 0
}

export function isPromotedToolResultPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (candidate.state?.status !== "completed") return false
  if ((candidate.state.attachments?.length ?? 0) === 0) return false
  if (toolResultPresentation(candidate) === "artifact-only") return true
  return isMediaGenerationToolPart(candidate)
}

export function isActiveMediaGenerationToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (!isMediaGenerationToolPart(candidate)) return false
  return candidate.state?.status === "running"
}

export function shouldHideToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (candidate.state?.status === "error") return false

  const display = toolDisplayMetadata(candidate)
  if (display?.visibility === "hidden-unless-error") return true
  if (isActiveMediaGenerationToolPart(candidate)) return true
  return isPromotedToolResultPart(candidate)
}

export function primaryToolAttachments(part: unknown): FilePart[] {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool" || candidate.state?.status !== "completed") return []

  const attachments = candidate.state.attachments ?? []
  if (attachments.length === 0) return []

  const metadata = candidate.state.metadata ?? {}
  const display = toolDisplayMetadata(candidate)
  const rawIds = display?.primaryAttachmentIds ?? metadata.primaryAttachmentIds
  if (!Array.isArray(rawIds) || rawIds.length === 0) return attachments

  const ids = new Set(rawIds.filter((id): id is string => typeof id === "string" && id.length > 0))
  if (ids.size === 0) return attachments

  const selected = attachments.filter((attachment) => ids.has(attachment.id))
  return selected.length > 0 ? selected : attachments
}
