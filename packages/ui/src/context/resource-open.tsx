import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { createContext, useContext, type Accessor, type ParentProps } from "solid-js"
import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { AttachmentFile } from "../components/attachment-card-utils"
import type { ImagePreviewImage } from "../components/image-preview-model"

export type OpenableResource =
  | (ResourceReference.Target & { mime?: string; filename?: string })
  | {
      kind: "attachment"
      file: AttachmentFile
      serverUrl?: string
    }

export interface ResourceOpenOptions {
  prefer?: "preview" | "workspace" | "external"
  focusTarget?: () => HTMLElement | undefined
  context?: ResourceReference.Context
  location?: ResourceReference.Location
  newTab?: boolean
  signal?: AbortSignal
  imagePreview?: { images: ImagePreviewImage[]; index: number }
}

export type ResourceOpenResult =
  | { status: "opened" | "dispatched" | "cancelled" }
  | { status: "unavailable"; reason: string }

export type ToolReviewTarget = { sessionID: string; messageID: string; partID: string; path?: string }
export type ToolActivityTarget = { sessionID: string; messageID: string; partID: string; callID?: string }
export type ActivityDetailTarget =
  | (ToolActivityTarget & { kind: "tool" })
  | { kind: "agent-delivery" | "compaction"; sessionID: string; messageID: string }

export interface ResourceOpenController {
  resolveUrl?(reference: ResourceReference.Target, context?: ResourceReference.Context): string | undefined
  openActivityDetail?(target: ActivityDetailTarget): boolean
  isActivityDetailSelected?(target: ActivityDetailTarget): boolean
  openToolActivity?(target: ToolActivityTarget, part?: ToolPart): boolean
  isToolActivitySelected?(target: ToolActivityTarget, part?: ToolPart): boolean
  openToolReview?(target: ToolReviewTarget): boolean
  open(resource: OpenableResource, options?: ResourceOpenOptions): Promise<ResourceOpenResult>
}

const ResourceOpenContext = createContext<ResourceOpenController>()
const ReferenceContext = createContext<Accessor<ResourceReference.Context | undefined>>()

export function ResourceReferenceProvider(props: ParentProps<{ value?: ResourceReference.Context }>) {
  return <ReferenceContext.Provider value={() => props.value}>{props.children}</ReferenceContext.Provider>
}

export function useReferenceContext() {
  return useContext(ReferenceContext) ?? (() => undefined)
}

export function ResourceOpenProvider(props: ParentProps<{ value: ResourceOpenController }>) {
  return <ResourceOpenContext.Provider value={props.value}>{props.children}</ResourceOpenContext.Provider>
}

export function useResourceOpen() {
  return useContext(ResourceOpenContext)
}
