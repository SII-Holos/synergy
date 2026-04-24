import { getFilename } from "@ericsanchezok/synergy-util/path"
import type { LocalScope } from "@/context/layout"

export function isGlobalScope(directory: string) {
  return directory === "global"
}

export function getScopeLabel(scope?: Pick<LocalScope, "worktree" | "name">, fallbackDirectory?: string) {
  const directory = scope?.worktree || fallbackDirectory || ""
  if (isGlobalScope(directory)) return "Home"
  return scope?.name || getFilename(directory) || "Project"
}
