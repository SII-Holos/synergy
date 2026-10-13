import { expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { createBuiltinPrimaryAgents } from "../../src/agent/builtin-primary"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { testRuntime } from "../support/runtime"

test("Core does not register the Boss primary agent", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      async fn() {
        const agents = createBuiltinPrimaryAgents({ defaults: [], user: [], role: () => undefined })
        expect(agents["boss-synergy"]).toBeUndefined()
        expect(await Agent.get("boss-synergy")).toBeUndefined()
        expect((await Agent.list()).some((agent) => agent.name === "boss-synergy")).toBe(false)
      },
    }),
  )
})
