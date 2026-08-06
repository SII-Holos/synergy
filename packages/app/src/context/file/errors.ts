export function isWorkspaceFileNotFoundError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "NotFoundError"
}

export function isFileWriteConflictError(input: unknown): boolean {
  if (!(input instanceof Error) || input.name !== "APIError") return false
  const data = (input as { data?: { statusCode?: number } }).data
  return data?.statusCode === 409
}

export function isFileWriteDeniedError(input: unknown): boolean {
  if (!(input instanceof Error) || input.name !== "APIError") return false
  const data = (input as { data?: { statusCode?: number } }).data
  return data?.statusCode === 403
}

export function removePathTree(paths: string[], missingPath: string): string[] {
  return paths.filter((path) => path !== missingPath && !path.startsWith(missingPath + "/"))
}
