import path from "node:path"
import { CLI_DIR, type RuntimeArtifactProfile } from "./packages"

export function runtimeBuildPlan(_profile: RuntimeArtifactProfile) {
  return { entrypoints: [path.join(CLI_DIR, "src/launcher.ts")], external: [] as string[] }
}
