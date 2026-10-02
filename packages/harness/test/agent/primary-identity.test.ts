import { afterAll, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const identities = [
  ["general", "synergy", "Synergy"],
  ["coding", "synergy-max", "Synergy Max"],
  ["lightweight", "synergy-flash", "Synergy Flash"],
] as const

test("primary identities register visible native agents and select the general default", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        expect([...PrimaryAgentIdentity.roles]).toEqual(identities.map(([role]) => role))
        for (const [role, name, label] of identities) {
          expect(PrimaryAgentIdentity.names[role]).toBe(name)
          expect(PrimaryAgentIdentity.labels[role]).toBe(label)
          const agent = await Agent.get(name)
          expect(agent).toMatchObject({ name, mode: "primary", native: true })
          expect(agent?.hidden).not.toBe(true)
        }
        expect(await Agent.defaultAgent()).toBe(identities[0][1])
      },
    })
  }))

test("identity rendering preserves product names and unrelated text", () => {
  expect(PrimaryAgentIdentity.render("general", "{AGENT_NAME}: {AGENT_LABEL} in Synergy/.synergy")).toBe(
    "synergy: Synergy in Synergy/.synergy",
  )
})

afterAll(() => runtime.close())
