export function isNonBypassableMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return !!(metadata?.nonBypassable || metadata?.workspaceBoundary || metadata?.outsideWorkspace)
}

export class CapabilityRequest {
  readonly permission: string
  readonly patterns: string[]
  readonly metadata: Record<string, unknown>

  constructor(opts: { permission: string; patterns: string[]; metadata: Record<string, unknown> }) {
    this.permission = opts.permission
    this.patterns = opts.patterns
    this.metadata = opts.metadata
  }

  get nonBypassable(): boolean {
    return isNonBypassableMetadata(this.metadata)
  }
}
