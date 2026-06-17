export class CapabilityRequest {
  readonly permission: string
  readonly patterns: string[]
  readonly metadata: Record<string, unknown>

  constructor(opts: {
    permission: string
    patterns: string[]
    metadata: Record<string, unknown>
  }) {
    this.permission = opts.permission
    this.patterns = opts.patterns
    this.metadata = opts.metadata
  }

  get nonBypassable(): boolean {
    return !!(
      this.metadata.nonBypassable ||
      this.metadata.workspaceBoundary ||
      this.metadata.outsideWorkspace
    )
  }
}
