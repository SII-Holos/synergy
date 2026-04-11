import { FIXED_REGISTRY_PACKAGES, type ReleaseKind, type ReleaseState } from "./packages"
import { releaseStatePath } from "./runtime"

export type ReleaseContext = {
  kind: ReleaseKind
  version: string
  channel: string
  promoteTag: string | null
}

export function createReleaseState(context: ReleaseContext): ReleaseState {
  return {
    kind: context.kind,
    version: context.version,
    channel: context.channel,
    promoteTag: context.promoteTag,
    createdAt: new Date().toISOString(),
    registryPackages: [...FIXED_REGISTRY_PACKAGES],
    binaryAssets: [],
    releaseTag: context.kind === "stable" ? `v${context.version}` : null,
    githubReleaseID: null,
    githubReleaseTagName: null,
  }
}

export function summarizeState(state: ReleaseState) {
  return {
    kind: state.kind,
    version: state.version,
    channel: state.channel,
    promoteTag: state.promoteTag,
    packages: state.registryPackages.length,
    assets: state.binaryAssets.length,
    ...(state.kind === "stable" ? { statePath: releaseStatePath(state.kind, state.version) } : {}),
  }
}
