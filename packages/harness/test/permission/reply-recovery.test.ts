import { afterAll, expect, spyOn, test } from "bun:test"
import { ScopeContext } from "../../src/scope/context"
import { PermissionNext } from "../../src/permission/next"
import { PermissionRules } from "../../src/permission/rules"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("saving an always-allow decision fails without losing the pending request or applying a cached rule", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const pending = PermissionNext.ask({
          id: "permission_recovery",
          sessionID: "session_recovery",
          permission: "bash",
          patterns: ["first", "second"],
          metadata: {},
          ruleset: [],
        })
        const write = spyOn(Storage, "write").mockRejectedValueOnce(new Error("Storage unavailable"))
        try {
          await expect(PermissionNext.reply({ requestID: "permission_recovery", reply: "always" })).rejects.toThrow(
            "Storage unavailable",
          )
          expect((await PermissionNext.list()).map((request) => request.id)).toContain("permission_recovery")
          expect(await PermissionRules.userRuleset()).toEqual([])
        } finally {
          write.mockRestore()
        }
        await PermissionNext.reply({ requestID: "permission_recovery", reply: "always" })
        await pending
        expect(await PermissionNext.list()).toEqual([])
        expect((await PermissionRules.userRuleset()).map((rule) => rule.pattern)).toEqual(["first", "second"])
      },
    })
  }))
