export function isWorkspaceFileNotFoundError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "NotFoundError"
}

export function isWorkspaceFileTooLargeError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "WorkspaceFileTooLargeError"
}

export function isFileWriteConflictError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "WorkspaceFileWriteConflictError"
}

export function isFileWriteDeniedError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "WorkspaceFileAccessDeniedError"
}

export function fileWriteErrorMessage(input: unknown): string | undefined {
  if (!input || typeof input !== "object" || input instanceof Error) return undefined
  const candidate = input as { data?: { message?: unknown }; message?: unknown }
  if (candidate.data && typeof candidate.data.message === "string") return candidate.data.message
  if (typeof candidate.message === "string") return candidate.message
  return undefined
}

export function removePathTree(paths: string[], missingPath: string): string[] {
  return paths.filter((path) => path !== missingPath && !path.startsWith(missingPath + "/"))
}
