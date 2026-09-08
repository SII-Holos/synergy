import path from "node:path"
import { REPO_ROOT, RUNTIME_RELEASE_TARGETS, releasePackageDirectory, type RuntimeArtifactProfile } from "./packages"

const HARNESS_WORKERS = [
  "packages/harness/src/session/agent-turn/runner.ts",
  "packages/harness/src/enforcement/policy-worker/runner.ts",
  "packages/harness/src/observability/telemetry-worker.ts",
] as const
const PRODUCT_WORKERS = [
  "packages/plugin-host/src/plugin-runtime/runner.ts",
  "packages/connections/src/channel/provider/feishu/svg-raster-worker.ts",
] as const

export function runtimeBuildPlan(profile: RuntimeArtifactProfile) {
  const target = RUNTIME_RELEASE_TARGETS[profile]
  return {
    entrypoints: [
      path.join(releasePackageDirectory(target.package), target.entrypoint),
      ...HARNESS_WORKERS.map((file) => path.join(REPO_ROOT, file)),
      ...(profile === "full" ? PRODUCT_WORKERS.map((file) => path.join(REPO_ROOT, file)) : []),
    ],
    external:
      profile === "full"
        ? ["@aws-sdk/client-s3", "chromium-bidi", "chromium-bidi/*", "playwright-core", "playwright-core/*"]
        : ["@aws-sdk/client-s3"],
  }
}
