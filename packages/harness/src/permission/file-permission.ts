const readers = new Set(["read", "view_file", "scan_files", "file_search", "parse_code"])
const writers = new Set([
  "edit",
  "write",
  "revise_file",
  "save_file",
  "resolve_conflicts",
  "apply_patch",
  "patch",
  "multiedit",
])

export function filePermissionNames(permission: string): readonly string[] {
  if (readers.has(permission)) return ["read", permission]
  if (writers.has(permission)) return ["edit", permission]
  return [permission]
}

export function isFilePermission(permission: string): boolean {
  return readers.has(permission) || writers.has(permission)
}
