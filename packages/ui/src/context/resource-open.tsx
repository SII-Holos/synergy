import { createContext, useContext, type ParentProps } from "solid-js"
import type { AttachmentFile } from "../components/attachment-card-utils"

export type OpenableResource =
  | {
      kind: "attachment"
      file: AttachmentFile
      serverUrl?: string
    }
  | {
      kind: "workspace-file"
      path: string
      mime?: string
      filename?: string
    }
  | {
      kind: "url"
      url: string
      mime?: string
      filename?: string
    }

export interface ResourceOpenOptions {
  prefer?: "preview" | "workspace" | "external"
  focusTarget?: () => HTMLElement | undefined
}

export type ToolReviewTarget = { sessionID: string; messageID: string; partID: string; path?: string }
export type ToolActivityTarget = { sessionID: string; messageID: string; partID: string; callID?: string }
export type ActivityDetailTarget =
  | (ToolActivityTarget & { kind: "tool" })
  | { kind: "agent-delivery" | "compaction"; sessionID: string; messageID: string }

export interface ResolvedAttachmentReference {
  file: AttachmentFile
  serverUrl: string
}

export interface ResourceOpenController {
  resolveAttachmentReference?(reference: string, filename?: string): ResolvedAttachmentReference | undefined
  openActivityDetail?(target: ActivityDetailTarget): boolean
  isActivityDetailSelected?(target: ActivityDetailTarget): boolean
  openToolActivity?(target: ToolActivityTarget): boolean
  isToolActivitySelected?(target: ToolActivityTarget): boolean
  openToolReview?(target: ToolReviewTarget): boolean
  open(resource: OpenableResource, options?: ResourceOpenOptions): boolean
  openAttachment(file: AttachmentFile, options?: ResourceOpenOptions & { serverUrl?: string }): boolean
  resolveWorkspacePath?(path: string | undefined): string | undefined
  openWorkspaceSource?(path: string): boolean
}

const ResourceOpenContext = createContext<ResourceOpenController>()

export function ResourceOpenProvider(props: ParentProps<{ value: ResourceOpenController }>) {
  return <ResourceOpenContext.Provider value={props.value}>{props.children}</ResourceOpenContext.Provider>
}

export function useResourceOpen() {
  return useContext(ResourceOpenContext)
}
