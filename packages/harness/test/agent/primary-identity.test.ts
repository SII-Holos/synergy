import { afterAll, expect, test } from "bun:test"
import { Agent } from "../../src/agent/agent"
import { PrimaryAgentIdentity } from "../../src/agent/primary-identity"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
const identities = [
  ["general", "atlas", "Atlas"],
  ["coding", "forge", "Forge"],
  ["lightweight", "pico", "Pico"],
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
        for (const name of ["synergy", "synergy-max", "synergy-flash"]) expect(await Agent.get(name)).toBeUndefined()
      },
    })
  }))

test("identity rendering preserves product names and unrelated text", () => {
  expect(PrimaryAgentIdentity.render("general", "{AGENT_NAME}: {AGENT_LABEL} in Synergy/.synergy")).toBe(
    "atlas: Atlas in Synergy/.synergy",
  )
})

afterAll(() => runtime.close())

test("legacy execution names fail instead of selecting a different primary", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      async fn() {
        const { Session } = await import("../../src/session")
        const { createUserMessage } = await import("../../src/session/input")
        const { SessionInbox } = await import("../../src/session/inbox")
        const session = await Session.create({})
        for (const agent of ["synergy", "synergy-max", "synergy-flash"]) {
          await expect(
            createUserMessage({
              sessionID: session.id,
              agent,
              noReply: true,
              parts: [{ type: "text", text: "fixture" }],
            }),
          ).rejects.toThrow(`Agent not found: ${agent}`)
          await expect(
            SessionInbox.enqueueUser({
              sessionID: session.id,
              agent,
              noReply: true,
              parts: [{ type: "text", text: "fixture" }],
            }),
          ).rejects.toThrow(`Agent not found: ${agent}`)
        }
        expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
        expect(await SessionInbox.list(session.id)).toHaveLength(0)
      },
    })
  }))
