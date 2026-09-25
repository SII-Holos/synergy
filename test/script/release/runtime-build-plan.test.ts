import { expect, test } from "bun:test"
import path from "node:path"
import { REPO_ROOT } from "../../../script/release/shared/packages"
import { runtimeBuildPlan } from "../../../script/release/shared/runtime-build-plan"

for (const profile of ["core", "full"] as const)
  test(`${profile} compiles only the verified launcher and loads runtime modules from its sealed seed`, () => {
    const plan = runtimeBuildPlan(profile)
    expect(plan.entrypoints.map((file) => path.relative(REPO_ROOT, file))).toEqual(["packages/cli/src/launcher.ts"])
    expect(plan.external).toEqual([])
  })
