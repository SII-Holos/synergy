import path from "node:path"
import { CLI_DIR, type RuntimeArtifactProfile } from "./packages"

export function runtimeBuildPlan(_profile: RuntimeArtifactProfile) {
  // Provenance: https://github.com/ZJONSSON/node-unzipper/blob/master/lib/Open/index.js
  // Local adaptation: application installation reads local ZIP files; the optional S3 adapter is never used.
  return { entrypoints: [path.join(CLI_DIR, "src/launcher.ts")], external: ["@aws-sdk/client-s3"] }
}
