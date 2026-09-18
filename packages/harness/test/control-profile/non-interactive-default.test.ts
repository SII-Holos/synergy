import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"

function channelEndpoint() {
  return SessionEndpoint.fromChannel({ type: "test", accountId: "account", chatId: `chat-${crypto.randomUUID()}` })
}

describe("non-interactive default control profile", () => {
  test("defaults a channel-sourced session to autonomous with nothing configured", async () => {
    await using dir = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const scope = await dir.scope()
        const session = await Session.getOrCreateForEndpoint(channelEndpoint(), {
          scope,
          interaction: SessionInteraction.unattended("channel:test"),
        })

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("autonomous")

        await Session.remove(session.id)
      },
    })
  })

  test("honors the configured non-interactive profile", async () => {
    await using dir = await tmpdir({ git: true, config: { nonInteractiveControlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const scope = await dir.scope()
        const session = await Session.getOrCreateForEndpoint(channelEndpoint(), {
          scope,
          interaction: SessionInteraction.unattended("channel:test"),
        })

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("prefers the non-interactive profile over a generic global controlProfile", async () => {
    // The hoist regression: removing the channel host's explicit profile must not
    // let an operator's interactive default turn unattended work into `guarded`.
    await using dir = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const scope = await dir.scope()
        const session = await Session.getOrCreateForEndpoint(channelEndpoint(), {
          scope,
          interaction: SessionInteraction.unattended("channel:test"),
        })

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("autonomous")

        await Session.remove(session.id)
      },
    })
  })

  test("lets an explicit session profile win over the non-interactive key", async () => {
    await using dir = await tmpdir({ git: true, config: { nonInteractiveControlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const scope = await dir.scope()
        const session = await Session.getOrCreateForEndpoint(channelEndpoint(), {
          scope,
          interaction: SessionInteraction.unattended("channel:test"),
          controlProfile: "guarded",
        })

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("lets an agent profile win over the non-interactive key", async () => {
    await using dir = await tmpdir({ git: true, config: { nonInteractiveControlProfile: "autonomous" } })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const scope = await dir.scope()
        const session = await Session.getOrCreateForEndpoint(channelEndpoint(), {
          scope,
          interaction: SessionInteraction.unattended("channel:test"),
        })

        expect(
          await Session.resolveEffectiveControlProfile({
            sessionID: session.id,
            agentControlProfile: "full_access",
          }),
        ).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("leaves interactive sessions unaffected by the non-interactive key", async () => {
    await using dir = await tmpdir({ git: true, config: { nonInteractiveControlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await dir.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })
})
