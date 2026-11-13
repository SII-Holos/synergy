import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteStore } from "../src"
import { NoteVersions } from "../src/version-store"
import { testRuntime } from "./support/runtime"

test("Note content and owner metadata updates retain immutable exact versions", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const first = await NoteStore.create({ title: "First version" })
        const second = await NoteStore.update("home", first.id, {
          title: "Second version",
          expectedVersion: first.version,
        })
        await NoteStore.mutateMetadata("home", first.id, (draft) => {
          draft.pinned = true
        })
        expect(await NoteStore.getVersion("home", first.id, first.version)).toEqual(first)
        expect(await NoteStore.getVersion("home", first.id, second.version)).toEqual(second)
        expect((await NoteStore.getVersion("home", first.id, 3)).pinned).toBe(true)
        await NoteStore.archive("home", [first.id])
        expect((await NoteStore.getVersion("home", first.id, 4)).archived).toBe(true)
        expect((await NoteStore.getVersion("home", first.id, 1)).archived).toBe(false)
        await expect(NoteStore.getVersion("foreign-project", first.id, 1)).rejects.toThrow()
        await expect(NoteStore.getVersion("home", first.id, 0)).rejects.toThrow()
      },
    }),
  )
})

test("historical migration records only the retained proven Note version", async () => {
  const { noteVersionMigration } = await import("../src/version-store")
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const retained = {
      id: "note_legacy",
      title: "Retained",
      content: { type: "doc", content: [] },
      pinned: false,
      global: true,
      archived: false,
      tags: [],
      kind: "note",
      version: 7,
      time: { created: 1, updated: 7 },
    }
    const unloaded = { ...retained, id: "note_unloaded", kind: "fixture-document", futureOwner: { retained: true } }
    const legacy = {
      id: "note_unloaded_legacy",
      title: "Opaque legacy document",
      kind: "fixture-document",
      contentText: "The absent owner has not supplied a canonical document",
      version: 3,
      fixture: { future: [1, { keep: true }] },
    }
    await Storage.write(["notes", "home", retained.id], retained)
    await Storage.write(["notes", "home", unloaded.id], unloaded)
    await Storage.write(["notes", "home", legacy.id], legacy)
    await noteVersionMigration.up(() => {})
    await noteVersionMigration.up(() => {})
    expect(await NoteStore.getVersion("home", retained.id, 7)).toEqual(retained)
    expect(await NoteVersions.read("home", unloaded.id, 7)).toEqual(unloaded)
    await expect(NoteStore.getVersion("home", unloaded.id, 7)).rejects.toBeInstanceOf(Storage.NotFoundError)
    expect(await Storage.read(["notes", "home", legacy.id])).toEqual(legacy)
    await expect(NoteVersions.read("home", legacy.id, 3)).rejects.toBeInstanceOf(Storage.NotFoundError)
    await expect(NoteStore.getVersion("home", retained.id, 6)).rejects.toThrow()
  })
})

test("retained-version migration rejects malformed documents whose kind owner is available", async () => {
  const { noteVersionMigration } = await import("../src/version-store")
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const malformed = { id: "note_incomplete", title: "Incomplete ordinary Note", kind: "note", version: 3 }
    const key = ["notes", "home", malformed.id]
    await Storage.write(key, malformed)
    await expect(noteVersionMigration.up(() => {})).rejects.toHaveProperty("name", "ZodError")
    expect(await Storage.read(key)).toEqual(malformed)
    await expect(NoteVersions.read("home", malformed.id, 3)).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})

test("deleting an archived Note removes its private retained versions", async () => {
  await using runtime = await testRuntime()
  await runtime.run(() =>
    ScopeContext.provide({
      scope: Scope.home(),
      workspace: null,
      fn: async () => {
        const note = await NoteStore.create({ title: "Private versions" })
        await NoteStore.update("home", note.id, { title: "Later private content" })
        await NoteStore.archive("home", [note.id])
        await NoteStore.remove("home", note.id)
        await expect(NoteStore.getVersion("home", note.id, 1)).rejects.toThrow()
        await expect(NoteStore.getVersion("home", note.id, 2)).rejects.toThrow()
      },
    }),
  )
})

test("transfer snapshots preserve unknown canonical owner fields and never replace a missing version", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const retained = {
      id: "note_future",
      title: "Future owner",
      content: { type: "doc", content: [] },
      pinned: false,
      global: true,
      archived: false,
      tags: [],
      kind: "note",
      version: 7,
      time: { created: 1, updated: 7 },
      futureOwner: { original: "retained exactly" },
    }
    await Storage.write(["notes", "home", retained.id], retained)
    expect(await NoteStore.snapshotForTransfer("home", retained.id, 7)).toEqual(retained)
    await expect(NoteStore.snapshotForTransfer("home", retained.id, 6)).rejects.toThrow()
    await expect(
      NoteStore.installTransferred({ scopeID: "home", sessionID: "session", handoffID: "handoff", note: retained }),
    ).rejects.toThrow("activation")
  })
})
