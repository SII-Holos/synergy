import type { SessionMeta } from "@/composables/use-session-meta"

export function promptDockBackToParentID(meta: Pick<SessionMeta, "showBackToParent" | "parentID">): string | undefined {
  if (!meta.showBackToParent) return undefined
  return meta.parentID ?? undefined
}
