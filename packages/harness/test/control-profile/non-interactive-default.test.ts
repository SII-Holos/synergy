import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { SessionEndpoint } from "../../src/session/endpoint"
import { SessionInteraction } from "../../src/session/interaction"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function channelEndpoint() {
  return SessionEndpoint.fromChannel({ type: "test", accountId: "account", chatId: `chat-${crypto.randomUUID()}` })
}

describe("non-interactive default control profile", () => {
  test("defaults a channel-sourced session to autonomous with nothing configured", () =>
    runtime.run(async () => {
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
    }))

  test("honors the configured non-interactive profile", () =>
    runtime.run(async () => {
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
    }))

  test("refuses a top-level guarded for a non-interactive root", () =>
    runtime.run(async () => {
      // An ask raised with nobody attached would pend forever, so the generic
      // interactive default must not reach an unattended root.
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
    }))

  test("keeps a top-level profile that can answer for itself on a non-interactive root", () =>
    runtime.run(async () => {
      // full_access and autonomous are both valid for unattended work, so the
      // top-level value still wins over the non-interactive default.
      await using dir = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
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
    }))

  test("still applies a top-level guarded to an interactive session", () =>
    runtime.run(async () => {
      await using dir = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
      await ScopeContext.provide({
        scope: await dir.scope(),
        fn: async () => {
          const session = await Session.create({})

          expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("guarded")

          await Session.remove(session.id)
        },
      })
    }))

  test("lets an explicit session profile win over the non-interactive key", () =>
    runtime.run(async () => {
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
    }))

  test("lets an agent profile win over the non-interactive key", () =>
    runtime.run(async () => {
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
    }))

  test("leaves interactive sessions unaffected by the non-interactive key", () =>
    runtime.run(async () => {
      await using dir = await tmpdir({ git: true, config: { nonInteractiveControlProfile: "full_access" } })
      await ScopeContext.provide({
        scope: await dir.scope(),
        fn: async () => {
          const session = await Session.create({})

          expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("guarded")

          await Session.remove(session.id)
        },
      })
    }))
})

afterRuntimeTests(() => runtime.close())
