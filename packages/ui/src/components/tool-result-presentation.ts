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
    input?: unknown
    output?: string
    error?: string
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

export function toolHistoricalText(part: MaybeToolPart): string | undefined {
  const text =
    part.state?.status === "error"
      ? part.state.error
      : part.state?.status === "completed"
        ? part.state.output
        : undefined
  if (!text) return undefined
  try {
    const value: unknown = JSON.parse(text)
    if (value !== null && typeof value === "object") return undefined
  } catch {}
  return text
}

const toolFeatures: ReadonlyArray<readonly [RegExp, string]> = [
  [/^note_/, "note"],
  [/^(memory_|experience_)/, "library"],
  [/^agenda_/, "agenda"],
  [/^(light_loop_|loop_stop$)/, "light-loop"],
  [/^blueprint_/, "blueprint"],
  [/^(lattice_|pathway_)/, "lattice"],
  [/^boss_/, "boss"],
  [/^anima_/, "anima"],
  [/^(channel_|response_card$|clarus_)/, "channels"],
  [/^email_/, "email"],
  [/^holos_/, "holos"],
  [/^github_/, "github"],
  [/^(worktree_|project_|session_control$)/, "workbench"],
  [/^browser_/, "browser"],
  [/^computer_/, "computer"],
  [/^(openai_image_|speak$|look_at$|scan_document$|render$)/, "media"],
  [/^mcp__/, "mcp"],
  [/^plugin__/, "plugin-host"],
  [/^(parse_code$|ast_grep$)/, "code-tools"],
  [/^lsp(?:_|$)/, "lsp"],
]

export function metadataRequiredFeatures(metadata: Record<string, unknown> | undefined): string[] {
  const required = metadata?.requiredFeatures
  return Array.isArray(required) ? required.filter((id): id is string => typeof id === "string" && id.length > 0) : []
}

export function toolRequiredFeatures(part: MaybeToolPart): string[] {
  const tool = part.tool ?? ""
  const feature = toolFeatures.find(([pattern]) => pattern.test(tool))?.[1]
  const required = feature ? [feature] : []
  if (tool.startsWith("note_")) {
    const metadata = part.state?.metadata
    const kinds = metadata?.kinds
    const input = part.state?.input
    const kind = input && typeof input === "object" && "kind" in input ? input.kind : undefined
    const blueprint =
      (metadata?.kind ?? kind) === "blueprint" ||
      (Array.isArray(kinds) && kinds.length > 0 && kinds.every((kind) => kind === "blueprint"))
    if (blueprint) required.push("blueprint")
  }
  return [...new Set([...required, ...metadataRequiredFeatures(part.state?.metadata)])]
}

export function toolFeatureAvailable(part: MaybeToolPart, hasFeature: (id: string) => boolean = () => false): boolean {
  return toolRequiredFeatures(part).every(hasFeature)
}
