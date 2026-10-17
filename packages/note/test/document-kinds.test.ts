import { expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteDocumentKinds, NoteStore, NoteTypes } from "../src"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { z } from "zod"
import { NoteRoute } from "../src/routes/note"
import { testRuntime } from "./support/runtime"
import { NoteListTool } from "../src/tools/note-list"
import { NoteSearchTool } from "../src/tools/note-search"
import { NoteWriteTool } from "../src/tools/note-write"
import type { Tool } from "@ericsanchezok/synergy-harness/tool/tool"
import { ToolRegistry } from "@ericsanchezok/synergy-harness/tool/registry"

test("Note hides documents whose kind owner is absent without changing their stored data", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const plain = await NoteStore.create({ title: "Ordinary note" })
        const hidden = {
          ...plain,
          id: "nte_hidden",
          kind: "blueprint",
          blueprint: {
            activeLoopID: "blp_preserved",
            runCount: 3,
            future: { checkpoint: [1, 2] },
          },
        }
        const key = ["notes", "home", hidden.id]
        await Storage.write(key, hidden)
        await Storage.remove(["notes", "home", "_index"])
        expect((await NoteStore.list("home")).map((note) => note.id)).toEqual([plain.id])
        expect((await NoteStore.listMeta("home")).map((note) => note.id)).toEqual([plain.id])
        const context: Tool.Context = {
          sessionID: "",
          messageID: "",
          callID: "",
          agent: "test-strategist",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        const list = await NoteListTool.init()
        const listed = await list.execute(list.parameters.parse({ scope: "global" }), context)
        expect(listed.output).toContain(plain.id)
        expect(listed.output).not.toContain(hidden.id)
        const search = await NoteSearchTool.init()
        const searched = await search.execute(
          search.parameters.parse({ pattern: "Ordinary", scope: "global" }),
          context,
        )
        expect(searched.output).toContain(plain.id)
        expect(searched.output).not.toContain(hidden.id)
        await expect(NoteStore.get("home", hidden.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
        await expect(NoteStore.getAny("home", hidden.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
        for (const route of [`/${hidden.id}`, `/export/${hidden.id}`])
          expect((await NoteRoute().request(route)).status).toBe(404)
        await expect(NoteStore.update("home", hidden.id, { title: "Changed" })).rejects.toBeInstanceOf(
          Storage.NotFoundError,
        )
        await expect(NoteStore.archive("home", [hidden.id])).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect(await Storage.read<typeof hidden>(key)).toEqual(hidden)
      },
    }),
  )
})

test("Note-only input schemas reject an unavailable document kind and its metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    expect(NoteTypes.CreateInput.safeParse({ title: "Unavailable", kind: "blueprint" }).success).toBe(false)
    expect(NoteTypes.CreateInput.safeParse({ title: "Unavailable", blueprint: { runCount: 1 } }).success).toBe(false)
    expect(NoteTypes.PatchInput.safeParse({ blueprint: { runCount: 1 } }).success).toBe(false)
    expect("blueprint" in NoteTypes.Info.shape).toBe(false)
    expect(JSON.stringify(z.toJSONSchema(NoteTypes.CreateInput))).not.toContain("blueprint")
    const write = await NoteWriteTool.init()
    expect(write.description.toLowerCase()).not.toContain("blueprint")
    expect(JSON.stringify(z.toJSONSchema(write.parameters))).not.toContain("blueprintDescription")
  })
})

test("ordinary mutations preserve unloaded extension fields and metadata", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const note = await NoteStore.create({ title: "Retained" })
        const key = ["notes", "home", note.id]
        const extension = { futureOwner: { version: 7, payload: ["keep", { nested: true }] } }
        await Storage.write(key, { ...note, ...extension })
        await NoteStore.update("home", note.id, { title: "Updated" })
        expect((await Storage.read<Record<string, unknown>>(key)).futureOwner).toEqual(extension.futureOwner)
      },
    }),
  )
})

test("every registered Note-only tool hides unavailable owner guidance and schemas", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const ids = (await ToolRegistry.ids()).filter((id) => id.startsWith("note_")).sort()
        expect(ids).toEqual([
          "note_archive",
          "note_delete",
          "note_edit",
          "note_list",
          "note_read",
          "note_search",
          "note_write",
        ])
        for (const id of ids) {
          const tool = await ToolRegistry.find(id)
          expect(tool).toBeDefined()
          expect(tool!.description).not.toMatch(/blueprint|lattice/i)
          expect(JSON.stringify(z.toJSONSchema(tool!.parameters))).not.toMatch(/blueprint|lattice/i)
        }
      },
    }),
  )
})

test("Note search and list show the selected document kind without a product-specific label", async () => {
  await using runtime = await testRuntime({
    register: () =>
      NoteDocumentKinds.register({
        kind: "fixture-document",
        title: "Fixture document",
        fields: { info: {}, create: {}, patch: {} },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const note = await NoteStore.create({ title: "Searchable fixture", kind: "fixture-document" })
        const context: Tool.Context = {
          sessionID: "",
          messageID: "",
          callID: "",
          agent: "test-strategist",
          abort: new AbortController().signal,
          metadata() {},
          async ask() {},
        }
        for (const id of ["note_list", "note_search"]) {
          const tool = (await ToolRegistry.find(id))!
          const result = await tool.execute(
            tool.parameters.parse({ pattern: "Searchable", kind: "fixture-document" }),
            context,
          )
          expect(result.output).toContain(note.id)
          expect(result.output).toContain("[fixture-document]")
          expect(result.output).not.toContain("[blueprint]")
        }
      },
    }),
  )
})

test("a reinstalled kind restores its metadata after ordinary edits while it was absent", async () => {
  await using tmp = await tmpdir()
  const contribution: NoteDocumentKinds.Contribution = {
    kind: "fixture-document",
    title: "Fixture document",
    fields: { info: { fixture: z.unknown().optional() }, create: {}, patch: {} },
  }
  let ordinaryID = ""
  const enabled = await testRuntime({ home: tmp.path, register: () => NoteDocumentKinds.register(contribution) })
  try {
    await enabled.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          const ordinary = await NoteStore.create({ title: "Ordinary" })
          ordinaryID = ordinary.id
          await Storage.write(["notes", "home", "nte_extension"], {
            ...ordinary,
            id: "nte_extension",
            kind: "fixture-document",
            fixture: { future: [1, { keep: true }] },
          })
          await Storage.remove(["notes", "home", "_index"])
          expect(await NoteStore.listMeta("home")).toHaveLength(2)
        },
      }),
    )
  } finally {
    await enabled.close()
  }
  const absent = await testRuntime({ home: tmp.path })
  try {
    await absent.run(() =>
      ScopeContext.provide({
        scope: Scope.home(),
        fn: async () => {
          expect(await NoteStore.listMeta("home")).toHaveLength(1)
          await NoteStore.update("home", ordinaryID, { title: "Changed while owner absent" })
          expect(NoteDocumentKinds.available("fixture-document")).toBe(false)
        },
      }),
    )
  } finally {
    await absent.close()
  }
  const restored = await testRuntime({ home: tmp.path, register: () => NoteDocumentKinds.register(contribution) })
  try {
    await restored.run(async () => {
      const notes = await NoteStore.listMeta("home")
      expect(notes).toHaveLength(2)
      expect((notes.find((note) => note.id === "nte_extension") as Record<string, unknown>).fixture).toEqual({
        future: [1, { keep: true }],
      })
      expect(() => NoteDocumentKinds.register({ ...contribution, kind: "too-late" })).toThrow("before")
    })
  } finally {
    await restored.close()
  }
})

test("Note owner projections only change a copy of their public fields", async () => {
  await using runtime = await testRuntime({
    register: () =>
      NoteDocumentKinds.register({
        kind: "fixture-document",
        title: "Fixture document",
        fields: {
          info: { fixture: z.object({ visible: z.string(), hidden: z.string().optional() }).optional() },
          create: {},
          patch: {},
        },
        project(fields) {
          const fixture = fields.fixture as Record<string, unknown> | undefined
          if (fixture) delete fixture.hidden
          fields.title = "Not owned"
        },
      }),
  })
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      fn: async () => {
        const note = await NoteStore.create({ title: "Retained title", kind: "fixture-document" })
        const key = ["notes", "home", note.id]
        const fixture = { visible: "available", hidden: "dormant", future: { retained: true } }
        await Storage.write(key, { ...note, fixture })
        await Storage.remove(["notes", "home", "_index"])
        for (const projected of [await NoteStore.get("home", note.id), (await NoteStore.listMeta("home"))[0]]) {
          expect(projected.title).toBe(note.title)
          expect((projected as Record<string, unknown>).fixture).toEqual({ visible: "available" })
        }
        expect((await Storage.read<Record<string, unknown>>(key)).fixture).toEqual(fixture)
        await NoteStore.update("home", note.id, { title: "Updated title" })
        expect((await Storage.read<Record<string, unknown>>(key)).fixture).toEqual(fixture)
      },
    }),
  )
})
