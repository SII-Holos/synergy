import { expect, test } from "bun:test"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteStore } from "../src"
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
    await Storage.write(["notes", "home", retained.id], retained)
    await noteVersionMigration.up(() => {})
    await noteVersionMigration.up(() => {})
    expect(await NoteStore.getVersion("home", retained.id, 7)).toEqual(retained)
    await expect(NoteStore.getVersion("home", retained.id, 6)).rejects.toThrow()
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
