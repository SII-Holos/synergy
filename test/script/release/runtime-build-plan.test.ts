import { expect, test } from "bun:test"
import path from "node:path"
import { REPO_ROOT } from "../../../script/release/shared/packages"
import { runtimeBuildPlan } from "../../../script/release/shared/runtime-build-plan"

test("core compile inputs contain only the CLI and harness workers", () => {
  const plan = runtimeBuildPlan("core")
  expect(plan.entrypoints.map((file) => path.relative(REPO_ROOT, file))).toEqual([
    "packages/cli/src/index.ts",
    "packages/harness/src/session/agent-turn/runner.ts",
    "packages/harness/src/enforcement/policy-worker/runner.ts",
    "packages/harness/src/observability/telemetry-worker.ts",
  ])
  expect(plan.external.some((name) => /playwright|chromium/.test(name))).toBe(false)
})

test("full compile inputs add the product entry and owned product workers", () => {
  const files = runtimeBuildPlan("full").entrypoints.map((file) => path.relative(REPO_ROOT, file))
  expect(files[0]).toBe("packages/product-runtime/src/index.ts")
  expect(files).toContain("packages/plugin-host/src/plugin-runtime/runner.ts")
  expect(files).toContain("packages/connections/src/channel/provider/feishu/svg-raster-worker.ts")
  expect(files).not.toContain("packages/cli/src/index.ts")
})
