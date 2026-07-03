import { describe, expect, test } from "bun:test"
import { Session } from "../../src/session"
import { ScopeContext } from "../../src/scope/context"
import { tmpdir } from "../fixture/fixture"

describe("Session.resolveEffectiveControlProfile", () => {
  test("uses guarded for ordinary sessions when nothing is configured", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("honors top-level config before source fallback", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.resolveEffectiveControlProfile({ sessionID: session.id })).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("honors agent config before top-level config", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

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

  test("honors explicit session config before agent and top-level config", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "guarded" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          controlProfile: "autonomous",
        })

        expect(
          await Session.resolveEffectiveControlProfile({
            sessionID: session.id,
            agentControlProfile: "full_access",
          }),
        ).toBe("autonomous")

        await Session.remove(session.id)
      },
    })
  })

  test("normalizes invalid configured profile values", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(
          await Session.resolveEffectiveControlProfile({
            sessionID: session.id,
            topLevelControlProfile: "bogus",
          }),
        ).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })
})
