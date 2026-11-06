import type { ToolPart } from "@ericsanchezok/synergy-sdk/client"
import { createContext, onCleanup, useContext, type Accessor, type ParentProps } from "solid-js"
import type { ResourceReference } from "@ericsanchezok/synergy-util/resource-reference"
import type { WorkbenchView } from "@ericsanchezok/synergy-util/workbench-view"
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
  origin?: "agent"
  canCommit?: () => boolean
  prefer?: "preview" | "workspace" | "external"
  focusTarget?: () => HTMLElement | undefined
  context?: ResourceReference.Context
  location?: ResourceReference.Location
  newTab?: boolean
  signal?: AbortSignal
  imagePreview?: { images: ImagePreviewImage[]; index: number }
}

export type ResourceOpenResult =
  | { status: "opened" | "dispatched" | "cancelled"; view?: Pick<WorkbenchView.View, "viewId" | "surface"> }
  | { status: "unavailable" | "blocked"; reason: string }

export interface ResourcePreview {
  title: string
  source: string
  description?: string
  path?: string
  image?: { src: string; alt: string }
  code?: { text: string; language?: string; startLine?: number }
  meta?: string
  unavailable?: string
}

export type ToolReviewTarget = { sessionID: string; messageID: string; partID: string; path?: string }
export type ToolActivityTarget = { sessionID: string; messageID: string; partID: string; callID?: string }
export type ActivityDetailTarget =
  | (ToolActivityTarget & { kind: "tool" })
  | { kind: "agent-delivery" | "compaction"; sessionID: string; messageID: string }

/** Why a reference cannot be rendered. Rendering decides on this before drawing
 *  anything, so a missing or ignored target never flashes as a broken image. */
export type ResourceAvailability =
  | { state: "available" }
  | {
      state: "unavailable"
      code: "ignored" | "missing" | "missing-asset" | "outside-workspace" | "unbound-workspace"
      path?: string
      reason: string
    }

export interface ResourceOpenController {
  present?(target: WorkbenchView.Target, options?: ResourceOpenOptions): Promise<ResourceOpenResult>
  resolveUrl?(reference: ResourceReference.Target, context?: ResourceReference.Context): string | undefined
  /** Reports whether the target can still be served. A path excluded from the
   *  workspace view (for example an ignored build directory) is unavailable even
   *  while the bytes exist, because the reference can never render or reopen. */
  inspectReference?(
    reference: ResourceReference.Target,
    context?: ResourceReference.Context,
  ): Promise<ResourceAvailability>
  openActivityDetail?(target: ActivityDetailTarget): boolean
  isActivityDetailSelected?(target: ActivityDetailTarget): boolean
  openToolActivity?(target: ToolActivityTarget, part?: ToolPart): boolean
  isToolActivitySelected?(target: ToolActivityTarget, part?: ToolPart): boolean
  openToolReview?(target: ToolReviewTarget): boolean
  preview?(resource: OpenableResource, options?: ResourceOpenOptions): Promise<ResourcePreview>
  openLabel?(resource: OpenableResource): string
  nativeLink?(reference: ResourceReference.Target): boolean
  contextKey?(): string
  open(resource: OpenableResource, options?: ResourceOpenOptions): Promise<ResourceOpenResult>
}

const ResourceOpenContext = createContext<ResourceOpenController>()
const ReferenceContext = createContext<Accessor<ResourceReference.Context | undefined>>()
const ResourcePreviewContext = createContext<{ claim(revoke: () => void): () => void }>()

export function ResourceReferenceProvider(props: ParentProps<{ value?: ResourceReference.Context }>) {
  return <ReferenceContext.Provider value={() => props.value}>{props.children}</ReferenceContext.Provider>
}

export function useReferenceContext() {
  return useContext(ReferenceContext) ?? (() => undefined)
}

export function ResourceOpenProvider(props: ParentProps<{ value: ResourceOpenController }>) {
  let preview: (() => void) | undefined
  const previews = {
    claim(revoke: () => void) {
      const previous = preview
      preview = revoke
      previous?.()
      return () => {
        if (preview === revoke) preview = undefined
      }
    },
  }
  onCleanup(() => preview?.())
  return (
    <ResourceOpenContext.Provider value={props.value}>
      <ResourcePreviewContext.Provider value={previews}>{props.children}</ResourcePreviewContext.Provider>
    </ResourceOpenContext.Provider>
  )
}

export function useResourceOpen() {
  return useContext(ResourceOpenContext)
}

export function useResourcePreviewOwner() {
  return useContext(ResourcePreviewContext)
}
