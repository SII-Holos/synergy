import type { ControlProfile, ProfileId, ProfileIdInput, ResolutionContext, ResolvedProfile } from "./types"
import { buildProfile, getProfileLabel, normalizeProfileId, PROFILE_IDS } from "./profiles"

export namespace ControlProfileCompiler {
  export const profileIds = PROFILE_IDS

  export function getProfile(id: string): Pick<ControlProfile, "label"> {
    return { label: getProfileLabel(id) }
  }

  export function normalize(id: string | undefined): ProfileId {
    return normalizeProfileId(id)
  }

  export function resolve(id: ProfileIdInput | string, context: ResolutionContext): ResolvedProfile {
    if (!context.workspace) {
      throw new Error("workspace context is required to resolve a profile")
    }
    return buildProfile(id, context)
  }
}
