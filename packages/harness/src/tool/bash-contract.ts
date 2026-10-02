import type { Tool } from "./tool"
import type { MessageV2 } from "../session/message-v2"
import type { SandboxExecutionWrapper } from "../sandbox/types"

export interface BashParams {
  command: string
  description: string
  workdir?: string
  background?: boolean
  yieldSeconds?: number
}

export interface BashMetadata {
  output?: string
  description?: string
  exit?: number | null
  signal?: string | null
  processId?: string
  background?: boolean
  durationMs?: number
}

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

export type BashSandboxPrepare = (
  input: BashSandboxPrepareInput,
) => Promise<SandboxExecutionWrapper & { id?: string; intentDigest?: string; cleanup?: () => Promise<void> }>

export const MAX_METADATA_LENGTH = 30_000

export function truncateMetadataOutput(output: string) {
  return output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output
}
