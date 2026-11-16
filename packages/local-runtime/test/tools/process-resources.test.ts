import { expect, test } from "bun:test"
import { ProcessAccessSource } from "@ericsanchezok/synergy-harness/process/access-source"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Session } from "@ericsanchezok/synergy-harness/session"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { ProcessTool } from "../../src/tools/process"
import { testRuntime } from "../support/runtime"

test("process discovery preserves personal Workspace requirements while registered owners acquire no new resources", async () => {
  let resolved = 0
  await using personal = await testRuntime()
  await using registered = await testRuntime({
    register() {
      ProcessAccessSource.register({
        async resolve() {
          resolved++
          throw new Error("No native caller was authorized by this contract fixture")
        },
      })
    },
  })
  for (const [runtime, restricted] of [
    [personal, false],
    [registered, true],
  ] as const) {
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        async fn() {
          expect((await ToolRegistry.ids()).includes("process")).toBe(restricted)
          const tool = await ProcessTool.init()
          expect(tool.resourceNeeds?.({ action: "list" })).toEqual({ workspace: !restricted })
          const session = await Session.create({ workspace: null })
          const execution = tool.execute(
            { action: "list" },
            {
              sessionID: session.id,
              messageID: "msg_process_resources",
              callID: "process-resources",
              agent: PrimaryAgentIdentity.names.general,
              abort: new AbortController().signal,
              metadata() {},
              async ask() {},
            },
          )
          if (restricted) await expect(execution).rejects.toThrow("genuine current Session Run caller")
          else await expect(execution).rejects.toBeInstanceOf(Scope.WorkspaceRequiredError)
        },
      }),
    )
  }
  expect(resolved).toBe(0)
})
