import type { ControlProfile, ProfileId, ProfileIdInput, ResolutionContext, ResolvedProfile } from "./types"
import { PROFILE_IDS } from "./ids"
import { buildProfile, getProfileLabel, normalizeProfileId } from "./profiles"

export namespace ControlProfileCompiler {
  export const profileIds = PROFILE_IDS

  export async function getProfile(id: string): Promise<Pick<ControlProfile, "label">> {
    return { label: await getProfileLabel(id) }
  }

  export function normalize(id: string | undefined): ProfileId {
    return normalizeProfileId(id)
  }

  export async function resolve(id: ProfileIdInput | string, context: ResolutionContext): Promise<ResolvedProfile> {
    if (!context.workspace) {
      throw new Error("workspace context is required to resolve a profile")
    }
    return buildProfile(id, context)
  }
}
