export function isWorkspaceFileNotFoundError(input: unknown): boolean {
  return !!input && typeof input === "object" && "name" in input && input.name === "NotFoundError"
}

export function removePathTree(paths: string[], missingPath: string): string[] {
  return paths.filter((path) => path !== missingPath && !path.startsWith(missingPath + "/"))
}
