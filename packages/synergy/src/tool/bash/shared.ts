import { SynergyLinkBash } from "@ericsanchezok/synergy-link-protocol"
import type { Tool } from "../tool"
import type { MessageV2 } from "@/session/message-v2"
import type { SandboxExecutionWrapper } from "@/sandbox/backend"

export type BashParams = SynergyLinkBash.ExecutePayload & {
  linkID?: string
  envID?: string
  backgroundAfterSeconds?: number
  timeoutSeconds?: number
}

export type BashMetadata = SynergyLinkBash.ResultMetadata

export interface BashResult {
  title: string
  metadata: BashMetadata
  output: string
  attachments?: MessageV2.AttachmentPart[]
}

export type BashContext = Tool.Context<BashMetadata>

export interface BashSandboxPrepareInput {
  command: string
  extraReadRoots: string[]
}

export type BashSandboxPrepare = (input: BashSandboxPrepareInput) => Promise<SandboxExecutionWrapper>

export const MAX_METADATA_LENGTH = 30_000

export function truncateMetadataOutput(output: string) {
  return output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output
}
