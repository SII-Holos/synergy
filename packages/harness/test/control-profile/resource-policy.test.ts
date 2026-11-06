import { afterAll, expect, test } from "bun:test"
import { ApprovalPolicy } from "../../src/control-profile/approval"
import { buildProfile } from "../../src/control-profile/profiles"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("resource restrictions narrow guarded and autonomous authority; full access remains explicit", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        for (const mode of ["guarded", "autonomous", "full_access"] as const) {
          const profile = await buildProfile(mode, { workspace: tmp.path, workspaceType: "main" })
          const decide = (resourcePolicy: string) =>
            ApprovalPolicy.decidePermission(profile, "browser", { capability: "web_read", resourcePolicy }).action
          expect(decide("deny")).toBe(mode === "full_access" ? "allow" : "deny")
          expect(decide("ask")).toBe(mode === "full_access" ? "allow" : mode === "autonomous" ? "deny" : "ask")
          expect(decide("allow")).toBe(
            ApprovalPolicy.decidePermission(profile, "browser", { capability: "web_read" }).action,
          )
        }
      },
    })
  }))
