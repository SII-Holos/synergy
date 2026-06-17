import type { ControlProfile, ProfileId, ResolutionContext, ResolvedProfile } from "./types"
import { buildProfile, getProfileLabel } from "./profiles"

export namespace ControlProfileCompiler {
  export const profileIds: readonly ProfileId[] = ["review", "workspace", "auto_review", "full_access"]

  export function getProfile(id: string): Pick<ControlProfile, "label"> {
    return { label: getProfileLabel(id) }
  }

  export function resolve(id: string, context: ResolutionContext): ResolvedProfile {
    if (!context.workspace) {
      throw new Error("workspace context is required to resolve a profile")
    }
    return buildProfile(id, context)
  }
}
