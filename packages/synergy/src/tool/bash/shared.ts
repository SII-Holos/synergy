import { MetaProtocolBash, MetaProtocolEnv } from "@ericsanchezok/meta-protocol"
import type { Tool } from "../tool"

export type BashParams = MetaProtocolBash.ExecutePayload & {
  envID?: MetaProtocolEnv.EnvID
}

export type BashMetadata = MetaProtocolBash.ResultMetadata

export interface BashResult {
  title: string
  metadata: BashMetadata
  output: string
}

export type BashContext = Tool.Context<BashMetadata>

export interface BashBackend {
  execute(params: BashParams, ctx: BashContext): Promise<BashResult>
}

export const MAX_METADATA_LENGTH = 30_000

export function truncateMetadataOutput(output: string) {
  return output.length > MAX_METADATA_LENGTH ? output.slice(0, MAX_METADATA_LENGTH) + "\n\n..." : output
}
