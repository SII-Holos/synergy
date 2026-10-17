import { expect, test } from "bun:test"
import { RuntimeComponents } from "@ericsanchezok/synergy-harness/lifecycle"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { server } from "@ericsanchezok/synergy-server/component"
import { Server } from "@ericsanchezok/synergy-server/server/server"
import { localRuntime } from "@ericsanchezok/synergy-local-runtime/component"
import { holos } from "../src/component"
import { Agent } from "@ericsanchezok/synergy-harness/agent/agent"
import { AgentPromptContributions } from "@ericsanchezok/synergy-harness/agent/prompt-contributions"
import { PrimaryAgentIdentity } from "@ericsanchezok/synergy-harness/agent/primary-identity"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"

const components = RuntimeComponents.resolve([localRuntime({ workers: false, environment: false }), holos()])
const adapters = await Promise.all(
  components.flatMap((component) => (component.adapters?.http ? [import(component.adapters.http.href)] : [])),
)
for (const selected of [false, true]) {
  test(`holos HTTP capability follows explicit composition after its adapters were imported (${selected})`, async () => {
    const composition = RuntimeComponents.compose([
      ...(selected ? components : [localRuntime({ workers: false, environment: false })]),
      server(),
    ])
    await using runtime = await testRuntime({
      composition: {
        register() {
          composition.register()
          if (selected) for (const adapter of adapters) adapter.registerHttp()
        },
      },
    })
    await runtime.run(async () => {
      const response = await Server.App().request("/global/capabilities")
      expect(response.status).toBe(200)
      const capabilities = await response.json()
      expect(capabilities.features.includes("holos")).toBe(selected)
      const spec = await Server.openapi()
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0)
      await ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const agent = await Agent.get(PrimaryAgentIdentity.names.general)
          const prompt = AgentPromptContributions.render(agent, new Set(["session_read"])).join("\n")
          expect(prompt.includes("remote profile is authoritative")).toBe(selected)
          expect(prompt.includes("do not create a local profile document")).toBe(selected)
          expect(prompt).not.toMatch(/session_read|contact target/)
          expect(AgentPromptContributions.render(agent, new Set())).toEqual([])
        },
      })
    })
  })
}
