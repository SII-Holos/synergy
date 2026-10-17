import { expect, test } from "bun:test"
import { z } from "zod"
import { Scope } from "../../src/scope"
import { ScopeContext } from "../../src/scope/context"
import { Session } from "../../src/session"
import { SessionSchemaRegistry } from "../../src/session/schema-registry"
import { Storage } from "../../src/storage/storage"
import { testRuntime } from "../support/runtime"

test("a synchronous Session owner projection cannot change canonical or other owner fields", async () => {
  await using runtime = await testRuntime({
    register() {
      SessionSchemaRegistry.register("fixture-owner", {
        shape: { fixture: z.object({ visible: z.string(), hidden: z.string().optional() }).optional() },
        project(fields) {
          const fixture = fields.fixture as Record<string, unknown> | undefined
          if (fixture) delete fixture.hidden
          fields.title = "Not owned"
        },
      })
    },
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const session = await Session.create({ title: "Retained title" })
        const key = ["sessions", "home", session.id, "info"]
        const fixture = { visible: "available", hidden: "dormant", future: { retained: true } }
        await Storage.write(key, { ...session, fixture })
        const raw = await Session.get(session.id)
        const projected = Session.publicInfo(raw)
        expect(projected.title).toBe(session.title)
        expect((projected as Record<string, unknown>).fixture).toEqual({ visible: "available" })
        expect((raw as Record<string, unknown>).fixture).toEqual(fixture)
        expect((await Storage.read<Record<string, unknown>>(key)).fixture).toEqual(fixture)
        await Session.update(session.id, (draft) => {
          draft.title = "Updated title"
        })
        expect((await Storage.read<Record<string, unknown>>(key)).fixture).toEqual(fixture)
      },
    }),
  )
})
