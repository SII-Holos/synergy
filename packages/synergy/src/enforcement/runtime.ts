import path from "path"
import type { WorkspacePolicy } from "../workspace/policy"

export class SandboxRuntime {
  readonly policy: WorkspacePolicy

  constructor(opts: { policy: WorkspacePolicy }) {
    this.policy = opts.policy
  }

  get root(): string {
    return this.policy.activeRoot
  }

  resolvePath(p: string): string {
    return path.join(this.policy.activeRoot, p)
  }

  contains(p: string): boolean {
    return this.policy.contains(p)
  }
}
