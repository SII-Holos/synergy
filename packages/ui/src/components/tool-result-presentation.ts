import {
  toolDisplayMetadata as sharedToolDisplayMetadata,
  toolDisplayPolicy,
} from "@ericsanchezok/synergy-util/activity"
import type { AttachmentPart } from "@ericsanchezok/synergy-sdk/client"

type MaybeToolPart = {
  tool?: string
  type?: string
  state?: {
    status?: string
    input?: Record<string, unknown>
    metadata?: Record<string, any>
    attachments?: AttachmentPart[]
  }
}

export type ToolDisplayKind = "default" | "media-generation"
export type ToolCardDisplay = "visible" | "hidden"
export type ToolMediaType = "image" | "video" | "audio"
export type ToolMediaSize = "small" | "medium" | "large"

export interface ToolMediaDisplay {
  type?: ToolMediaType
  actionLabel?: string
  pendingTitle?: string
  pendingDescription?: string
  aspectRatio?: "1:1" | "4:3" | "16:9" | "auto"
  size?: ToolMediaSize
}

export interface ToolDisplayMetadata {
  kind?: ToolDisplayKind
  toolCard?: ToolCardDisplay
  media?: ToolMediaDisplay
}

export function toolDisplayMetadata(part: unknown): ToolDisplayMetadata | undefined {
  const candidate = part as MaybeToolPart
  return sharedToolDisplayMetadata(candidate.state?.metadata) as ToolDisplayMetadata | undefined
}

export function isMediaGenerationToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  return candidate?.type === "tool" && toolDisplayPolicy(candidate.state?.metadata).mediaGeneration
}

export function isToolCardHidden(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  return candidate?.type === "tool" && toolDisplayPolicy(candidate.state?.metadata).toolCardHidden
}

export function isActiveMediaGenerationToolPart(part: unknown): boolean {
  const candidate = part as MaybeToolPart
  if (candidate?.type !== "tool") return false
  if (!isMediaGenerationToolPart(candidate)) return false
  return (
    candidate.state?.status === "pending" ||
    candidate.state?.status === "generating" ||
    candidate.state?.status === "running"
  )
}
