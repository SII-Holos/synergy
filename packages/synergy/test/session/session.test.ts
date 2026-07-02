import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { AppChannel } from "../../src/channel/app"
import { SessionEvent } from "../../src/session/event"
import { MessageV2 } from "../../src/session/message-v2"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { ScopeContext } from "../../src/scope/context"
import { Scope } from "../../src/scope"
import { Identifier } from "../../src/id/id"

Log.init({ print: false })

describe("session lifecycle events", () => {
  test("emits session.updated when a session is created", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const resolved = Promise.withResolvers<Session.Info>()
        const unsub = Bus.subscribe(SessionEvent.Updated, (event) => {
          resolved.resolve(event.properties.info as Session.Info)
        })

        const session = await Session.create({})
        const receivedInfo = await resolved.promise

        unsub()

        expect(receivedInfo.id).toBe(session.id)
        expect((receivedInfo.scope as Scope).id).toBe((session.scope as Scope).id)
        expect((receivedInfo.scope as Scope).directory).toBe((session.scope as Scope).directory)
        expect(receivedInfo.title).toBe(session.title)

        await Session.remove(session.id)
      },
    })
  })

  test("app channel sessions stay interactive", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await AppChannel.session()

        expect(session.interaction).toEqual(SessionInteraction.interactive("channel:app"))

        await Session.remove(session.id)
      },
    })
  })

  test("merging message metadata preserves summary fields", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Metadata Merge" })
        const user = (await Session.updateMessage({
          id: Identifier.ascending("message"),
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          metadata: { source: "prompt" },
        })) as MessageV2.User

        await Session.updateMessage({
          ...user,
          summary: { title: "Greeting in Chinese", diffs: [] },
        })

        await Session.mergeMessageMetadata({
          sessionID: session.id,
          messageID: user.id,
          metadata: { injectedContext: { memory: { ids: ["mem_1"] } } },
        })

        const messages = await Session.messages({ sessionID: session.id })
        const stored = messages.find((msg) => msg.info.id === user.id)?.info

        if (!stored || stored.role !== "user") throw new Error("expected stored user message")
        expect(stored.summary?.title).toBe("Greeting in Chinese")
        expect(stored.metadata?.source).toBe("prompt")
        expect(stored.metadata?.injectedContext).toEqual({ memory: { ids: ["mem_1"] } })

        await Session.remove(session.id)
      },
    })
  })

  test("child sessions inherit unattended interaction from parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          interaction: SessionInteraction.unattended("agenda"),
        })
        const child = await Session.create({
          parentID: parent.id,
        })

        expect(child.interaction).toEqual(parent.interaction)

        await Session.remove(parent.id)
      },
    })
  })

  test("resolveControlProfile walks the parent chain", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          controlProfile: "guarded",
        })
        const child = await Session.create({
          parentID: parent.id,
        })
        const grandchild = await Session.create({
          parentID: child.id,
        })

        // Neither child nor grandchild were created with an explicit
        // controlProfile — the resolver must walk to the root parent.
        expect(await Session.resolveControlProfile(grandchild.id)).toBe("guarded")

        await Session.remove(parent.id)
      },
    })
  })

  test("resolveControlProfile returns own value for root session", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          controlProfile: "autonomous",
        })

        expect(await Session.resolveControlProfile(session.id)).toBe("autonomous")

        await Session.remove(session.id)
      },
    })
  })

  test("resolveControlProfile falls back to top-level config for root session", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.resolveSessionControlProfile(session.id)).toBeUndefined()
        expect(await Session.resolveControlProfile(session.id)).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("fork inherits the source session's effective control profile", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const source = await Session.create({})
        const forked = await Session.fork({ sessionID: source.id })

        expect(forked.controlProfile).toBe("full_access")
        expect(await Session.resolveControlProfile(forked.id)).toBe("full_access")

        await Session.remove(source.id)
        await Session.remove(forked.id)
      },
    })
  })

  test("resolveControlProfile sees updated parent profile", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          controlProfile: "guarded",
        })
        const child = await Session.create({
          parentID: parent.id,
        })

        await Session.updateControlProfile(parent.id, "autonomous")

        expect(await Session.resolveControlProfile(child.id)).toBe("autonomous")

        await Session.remove(parent.id)
      },
    })
  })

  test("child sessions inherit the parent control profile via Session.get", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          controlProfile: "autonomous",
        })
        const child = await Session.create({
          parentID: parent.id,
          // Children no longer store controlProfile — inheritance is
          // resolved at runtime from the parent chain.
          controlProfile: "full_access",
        })

        // The raw return from create() shows what was stored.
        // After the refactor children never persist their own controlProfile.
        expect(child.controlProfile).toBeUndefined()
        // Session.get() resolves the profile by walking the parent chain.
        expect((await Session.get(child.id)).controlProfile).toBe("autonomous")
        // The resolver itself returns the same value.
        expect(await Session.resolveControlProfile(child.id)).toBe("autonomous")

        await Session.remove(parent.id)
      },
    })
  })

  test("parent control profile updates propagate via runtime resolver", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          controlProfile: "guarded",
        })
        const child = await Session.create({
          parentID: parent.id,
        })
        const grandchild = await Session.create({
          parentID: child.id,
        })

        await Session.updateControlProfile(parent.id, "autonomous")

        // updateControlProfile only touches the target session — no BFS.
        // Session.get() fills in the resolved profile for API clients.
        expect((await Session.get(parent.id)).controlProfile).toBe("autonomous")
        expect((await Session.get(grandchild.id)).controlProfile).toBe("autonomous")
        expect(await Session.resolveControlProfile(grandchild.id)).toBe("autonomous")

        await Session.remove(parent.id)
      },
    })
  })
})
