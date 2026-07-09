import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { AppChannel } from "../../src/channel/app"
import { SessionEndpoint } from "../../src/session/endpoint"
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

  test("limited message windows include referenced root users", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({ title: "Windowed Root" })
        const rootID = Identifier.ascending("message")
        await Session.updateMessage({
          id: rootID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "synergy",
          model: { providerID: "test", modelID: "test" },
          isRoot: true,
          rootID,
          visible: true,
          origin: { type: "user" },
        })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: session.id,
          messageID: rootID,
          type: "text",
          text: "run a long task",
          origin: "user",
        })

        const assistantIDs: string[] = []
        for (let i = 0; i < 5; i++) {
          const id = Identifier.ascending("message")
          assistantIDs.push(id)
          await Session.updateMessage({
            id,
            sessionID: session.id,
            role: "assistant",
            time: { created: Date.now(), completed: Date.now() },
            parentID: rootID,
            rootID,
            modelID: "test",
            providerID: "test",
            mode: "build",
            agent: "synergy",
            path: { cwd: tmp.path, root: tmp.path },
            summary: false,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
          })
          await Session.updatePart({
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID: id,
            type: "text",
            text: `assistant ${i}`,
            origin: "system",
          })
        }

        const expectedIDs = [rootID, ...assistantIDs.slice(-3)]
        const limited = await Session.messages({ sessionID: session.id, limit: 3 })
        const rawLimited = await Session.messages({ sessionID: session.id, limit: 3, raw: true })

        expect(limited.map((msg) => msg.info.id)).toEqual(expectedIDs)
        expect(rawLimited.map((msg) => msg.info.id)).toEqual(expectedIDs)

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

  test("initializes completion notice state for new sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(session.completionNotice).toEqual({ unread: false, silent: false })

        await Session.remove(session.id)
      },
    })
  })

  test("supports silent completion notice creation and child inheritance", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({ completionNotice: { silent: true } })
        const child = await Session.create({ parentID: parent.id })

        expect(parent.completionNotice).toEqual({ unread: false, silent: true })
        expect(child.completionNotice).toEqual({ unread: false, silent: true })

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
  test("resolveControlProfile falls back to guarded for ordinary root sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({})

        expect(await Session.resolveSessionControlProfile(session.id)).toBeUndefined()
        expect(await Session.resolveControlProfile(session.id)).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("resolveControlProfile falls back to autonomous for channel roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const root = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "acct_1",
            chatId: "chat_1",
          }),
        })
        const child = await Session.create({ parentID: root.id })

        expect(await Session.resolveControlProfile(root.id)).toBe("autonomous")
        expect(await Session.resolveControlProfile(child.id)).toBe("autonomous")

        await Session.remove(root.id)
      },
    })
  })

  test("resolveControlProfile honors top-level full_access for channel roots", async () => {
    await using tmp = await tmpdir({ git: true, config: { controlProfile: "full_access" } })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "acct_1",
            chatId: "chat_1",
          }),
        })

        expect(await Session.resolveControlProfile(session.id)).toBe("full_access")

        await Session.remove(session.id)
      },
    })
  })

  test("resolveControlProfile honors explicit guarded profile for channel roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          controlProfile: "guarded",
          endpoint: SessionEndpoint.fromChannel({
            type: "feishu",
            accountId: "acct_1",
            chatId: "chat_1",
          }),
        })

        expect(await Session.resolveControlProfile(session.id)).toBe("guarded")

        await Session.remove(session.id)
      },
    })
  })

  test("resolveControlProfile falls back to autonomous for agenda roots", async () => {
    await using tmp = await tmpdir({ git: true })
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await Session.create({
          agenda: { itemID: "agenda_item_1" },
        })

        expect(await Session.resolveControlProfile(session.id)).toBe("autonomous")

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
