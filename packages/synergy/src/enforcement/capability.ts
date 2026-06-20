export function isNonBypassableMetadata(metadata: Record<string, unknown> | undefined): boolean {
  return !!(metadata?.nonBypassable || metadata?.workspaceBoundary || metadata?.outsideWorkspace)
}
