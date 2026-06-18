import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { SessionInteraction } from "../../src/session/interaction"
import { AppChannel } from "../../src/channel/app"
import { GenesisChannel } from "../../src/channel/genesis"
import { SessionEvent } from "../../src/session/event"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util/log"
import { Instance } from "../../src/scope/instance"
import { Scope } from "../../src/scope"

Log.init({ print: false })

describe("session lifecycle events", () => {
  test("emits session.updated when a session is created", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await AppChannel.session()

        expect(session.interaction).toEqual(SessionInteraction.interactive("channel:app"))

        await Session.remove(session.id)
      },
    })
  })

  test("genesis channel sessions stay unattended", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const session = await GenesisChannel.session()

        expect(session.interaction).toEqual(SessionInteraction.unattended("channel:genesis"))

        await Session.remove(session.id)
      },
    })
  })

  test("child sessions inherit unattended interaction from parent", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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

  test("child sessions inherit the parent control profile even when another profile is supplied", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const parent = await Session.create({
          controlProfile: "manual",
        })
        const child = await Session.create({
          parentID: parent.id,
          controlProfile: "full_access",
        })

        expect(child.controlProfile).toBe("manual")

        await Session.remove(parent.id)
      },
    })
  })

  test("parent control profile updates propagate to existing child sessions", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
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

        expect((await Session.get(parent.id)).controlProfile).toBe("autonomous")
        expect((await Session.get(child.id)).controlProfile).toBe("autonomous")
        expect((await Session.get(grandchild.id)).controlProfile).toBe("autonomous")

        await Session.remove(parent.id)
      },
    })
  })
})
