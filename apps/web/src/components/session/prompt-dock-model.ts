import type { SessionMeta } from "@/composables/use-session-meta"

export function promptDockBackToParentID(meta: Pick<SessionMeta, "showBackToParent" | "parentID">): string | undefined {
  if (!meta.showBackToParent) return undefined
  return meta.parentID ?? undefined
}

export function promptDockForkSourceID(
  meta: Pick<SessionMeta, "isSubsession">,
  forkedFromID: string | undefined,
): string | undefined {
  if (meta.isSubsession) return undefined
  return forkedFromID
}

export function promptDockBackPath(
  meta: Pick<SessionMeta, "isSubsession">,
  backPath: string | undefined,
): string | undefined {
  if (meta.isSubsession) return undefined
  return backPath
}
