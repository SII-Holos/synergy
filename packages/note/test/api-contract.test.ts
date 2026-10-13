import { expect, test } from "bun:test"
import { Hono } from "hono"
import { generateSpecs } from "hono-openapi"
import { z } from "zod"
import { createSynergyClient } from "@ericsanchezok/synergy-sdk/client"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { runtimeHome } from "@ericsanchezok/synergy-harness/test/support/runtime-home"
import { NoteDocumentKinds } from "../src/document-kinds"
import { NoteRoute } from "../src/routes/note"
import { testRuntime } from "./support/runtime"

const contribution: NoteDocumentKinds.Contribution = {
  kind: "fixture-document",
  title: "Fixture document",
  fields: {
    info: { fixture: z.object({ value: z.string() }).optional() },
    create: { fixture: z.object({ value: z.string() }).optional() },
    patch: { fixture: z.object({ value: z.string() }).optional() },
  },
}

function client() {
  const app = new Hono().route("/note", NoteRoute())
  const transport = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) =>
      app.fetch(input instanceof Request ? input : new Request(input, init)),
    { preconnect() {} },
  )
  return createSynergyClient({ baseUrl: "http://note.test", fetch: transport })
}

test("the generated SDK keeps named Note inputs and preserves unavailable owner data through HTTP", async () => {
  await using home = await runtimeHome()
  const retained = { nested: ["keep", { version: 7 }] }
  {
    await using absent = await testRuntime({ home: home.host.home })
    await absent.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const sdk = client()
          const created = await sdk.note.create({ noteCreateInput: { title: "SDK note" } })
          expect(created.response.status).toBe(200)
          expect(created.data?.title).toBe("SDK note")
          if (!created.data) throw new Error("SDK Note creation failed")
          const key = ["notes", "home", created.data.id]
          const stored = await Storage.read<Record<string, unknown>>(key)
          await Storage.write(key, { ...stored, futureOwner: retained })
          await Storage.write(["notes", "home", "nte_unavailable"], {
            ...stored,
            id: "nte_unavailable",
            kind: "fixture-document",
            fixture: { value: "restored after reinstall" },
            futureOwner: retained,
          })
          await Storage.remove(["notes", "home", "_index"])
          expect((await sdk.note.get({ id: "nte_unavailable" })).response.status).toBe(404)
          expect((await sdk.note.list()).data?.map((note) => note.id)).toEqual([created.data.id])

          const read = await sdk.note.get({ id: created.data.id })
          expect(read.data).not.toHaveProperty("futureOwner")
          const updated = await sdk.note.update({
            id: created.data.id,
            notePatchInput: { title: "SDK changed", expectedVersion: created.data.version },
          })
          expect(updated.response.status).toBe(200)
          expect(updated.data?.title).toBe("SDK changed")
          expect(updated.data).not.toHaveProperty("futureOwner")
          expect((await Storage.read<Record<string, unknown>>(key)).futureOwner).toEqual(retained)
          const conflict = await sdk.note.update({
            id: created.data.id,
            notePatchInput: { title: "Stale SDK edit", expectedVersion: created.data.version },
          })
          expect(conflict.response.status).toBe(409)
          expect(conflict.error).toMatchObject({
            name: "NoteConflictError",
            data: { note: { id: created.data.id, title: "SDK changed", version: updated.data?.version } },
          })
          expect(conflict.error).not.toHaveProperty("data.note.futureOwner")
          expect((await Storage.read<Record<string, unknown>>(key)).futureOwner).toEqual(retained)
        },
      }),
    )
  }
  {
    await using installed = await testRuntime({
      home: home.host.home,
      register: () => NoteDocumentKinds.register(contribution),
    })
    await installed.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const restored = await client().note.get({ id: "nte_unavailable" })
          expect(restored.response.status).toBe(200)
          expect(restored.data).toMatchObject({
            kind: "fixture-document",
            fixture: { value: "restored after reinstall" },
          })
          expect(restored.data).not.toHaveProperty("futureOwner")
          expect(
            (await Storage.read<Record<string, unknown>>(["notes", "home", "nte_unavailable"])).futureOwner,
          ).toEqual(retained)
        },
      }),
    )
  }
})

for (const selected of [false, true]) {
  test(`Note OpenAPI retains SDK body names with its optional kind ${selected ? "selected" : "absent"}`, async () => {
    await using runtime = await testRuntime({
      register: selected ? () => NoteDocumentKinds.register(contribution) : undefined,
    })
    await runtime.run(async () => {
      const spec = await generateSpecs(new Hono().route("/note", NoteRoute()))
      const create = spec.paths?.["/note"]?.post?.requestBody
      const patch = spec.paths?.["/note/{id}"]?.put?.requestBody
      expect(create).toMatchObject({
        content: { "application/json": { schema: { $ref: "#/components/schemas/NoteCreateInput" } } },
      })
      expect(patch).toMatchObject({
        content: { "application/json": { schema: { $ref: "#/components/schemas/NotePatchInput" } } },
      })
      for (const name of ["NoteCreateInput", "NotePatchInput", "NoteInfo", "NoteMetaInfo"]) {
        const schema = spec.components?.schemas?.[name]
        expect(schema).toBeDefined()
        expect(JSON.stringify(schema).includes('"fixture-document"')).toBe(selected)
        expect(JSON.stringify(schema).includes('"fixture"')).toBe(selected)
      }
    })
  })
}
