import type { FileDiff } from "@ericsanchezok/synergy-sdk"

export function reviewFileKey(diff: Pick<FileDiff, "file" | "workspace" | "legacyRoot" | "operationID">) {
  const binding = diff.workspace
    ? JSON.stringify([diff.workspace.id, diff.workspace.generation, diff.workspace.root, diff.file])
    : diff.legacyRoot
      ? JSON.stringify(["legacy", diff.legacyRoot, diff.file])
      : diff.file
  return diff.operationID ? JSON.stringify(["operation", diff.operationID, binding]) : binding
}
