import type { CapabilityRequest } from "./capability"
import type { WorkspacePolicy } from "../workspace/policy"

export class ExecutionEnvelope {
  readonly request: CapabilityRequest
  readonly policy: WorkspacePolicy

  constructor(opts: { request: CapabilityRequest; policy: WorkspacePolicy }) {
    this.request = opts.request
    this.policy = opts.policy
  }

  canAutoApprove(): boolean {
    return !this.request.nonBypassable
  }
}
