import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { createBuiltinMaxSubagents } from "../../src/agent/builtin-max-subagents"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

test("Core does not register workflow reviewers through the max agent family", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const agents = createBuiltinMaxSubagents({ defaults: [], user: [], role: () => undefined })
        for (const name of ["supervisor", "lightloop-reviewer"]) {
          expect(agents[name]).toBeUndefined()
          expect(await Agent.get(name)).toBeUndefined()
        }
      },
    }),
  )
})
