import { expect, test } from "bun:test"
import { z } from "zod"
import { Bus } from "../../src/bus"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionEvent } from "../../src/session/event"
import { SessionSchemaRegistry } from "../../src/session/schema-registry"
import { testRuntime } from "../support/runtime"

test("the real completion producer captures its optional owner's source before a delayed observer reads it", async () => {
  const Binding = z.strictObject({ projectID: z.string(), epoch: z.number() })
  await using runtime = await testRuntime({
    register() {
      SessionSchemaRegistry.register("notice-fixture", {
        shape: { noticeBinding: Binding.optional() },
        ...{
          notificationReference(info: Readonly<Record<string, unknown>>) {
            const fields = Binding.parse(info.noticeBinding)
            return { version: 1, fields }
          },
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const session = await Session.create({
          title: "A private title must not enter source metadata",
          workspaceID: null,
          ...{ noticeBinding: { projectID: "project-a", epoch: 1 } },
        })
        const arrived = Promise.withResolvers<unknown>()
        const unsubscribe = Bus.subscribe(SessionEvent.Completion, (event) => {
          arrived.resolve(structuredClone(event.properties))
        })
        try {
          await Session.recordCompletionNotice(session.id)
          await Session.update(session.id, (draft) => {
            Object.assign(draft, { noticeBinding: { projectID: "project-b", epoch: 2 } })
          })
          const notice = await arrived.promise
          expect(notice).toMatchObject({
            sessionID: session.id,
            unreadCount: 1,
            source: {
              scopeID: session.scope.id,
              sessionID: session.id,
              references: { "notice-fixture": { version: 1, fields: { projectID: "project-a", epoch: 1 } } },
            },
          })
          expect(JSON.stringify(notice)).not.toContain(session.title)
          expect((await Session.get(session.id)).title).toBe(session.title)
        } finally {
          unsubscribe()
        }
      },
    }),
  )
})

test("source references are independent immutable snapshots and one owner cannot overwrite another reference", async () => {
  const first = { projectID: "project-a", epoch: 1 }
  const second = { projectID: "project-b", epoch: 2 }
  await using runtime = await testRuntime({
    register() {
      for (const [id, fields] of [
        ["first", first],
        ["second", second],
      ] as const)
        SessionSchemaRegistry.register(id, {
          shape: {},
          notificationReference: () => ({ version: 1, fields }),
        })
    },
  })
  await runtime.run(async () => {
    const info = { id: "session-a", scope: { id: "project-a" }, title: "Private", parentID: "parent-a" }
    const captured = SessionSchemaRegistry.captureNotificationSource(info)!
    await Promise.resolve()
    first.epoch = 9
    second.projectID = "later-project"
    info.parentID = "later-parent"
    expect(captured).toEqual({
      scopeID: "project-a",
      sessionID: "session-a",
      parentID: "parent-a",
      references: {
        first: { version: 1, fields: { projectID: "project-a", epoch: 1 } },
        second: { version: 1, fields: { projectID: "project-b", epoch: 2 } },
      },
    })
    expect(Object.isFrozen(captured.references.first!.fields)).toBe(true)
    expect(JSON.stringify(captured)).not.toContain(info.title)
  })
})

for (const malformed of [false, true])
  test(`an optional source owner cannot change personal completion semantics (${malformed ? "invalid" : "absent"})`, async () => {
    await using runtime = await testRuntime({
      register() {
        if (malformed)
          SessionSchemaRegistry.register("malformed", {
            shape: {},
            notificationReference: () => ({ version: 1, fields: { oversized: "private".repeat(1024) } }),
          })
      },
    })
    await runtime.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        workspace: null,
        fn: async () => {
          const session = await Session.create({ workspaceID: null })
          const notices: unknown[] = []
          const unsubscribe = Bus.subscribe(SessionEvent.Completion, (event) => notices.push(event.properties))
          try {
            await Session.recordCompletionNotice(session.id)
            expect(notices).toEqual([{ sessionID: session.id, unreadCount: 1 }])
            expect((await Session.get(session.id)).completionNotice.unreadCount).toBe(1)
          } finally {
            unsubscribe()
          }
        },
      }),
    )
  })
