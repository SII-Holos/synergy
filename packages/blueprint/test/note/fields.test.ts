import { afterAll, expect, test } from "bun:test"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { Scope } from "@ericsanchezok/synergy-harness/scope"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteStore } from "@ericsanchezok/synergy-note"
import { recordBlueprintNoteRun } from "../../src/note-kind"
import { testRuntime } from "./runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())
const inHome = (fn: () => Promise<void>) => runtime.run(() => ScopeContext.provide({ scope: Scope.home(), fn }))

test("Blueprint creation publishes authoring defaults and initializes run count", () =>
  inHome(async () => {
    const note = await NoteStore.create({
      title: "CI Blueprint",
      kind: "blueprint",
      blueprint: {
        description: "Run CI checks",
        defaultAgent: "forge",
        auditAgent: "security-reviewer",
      },
    })
    expect(note.blueprint).toEqual({
      description: "Run CI checks",
      defaultAgent: "forge",
      auditAgent: "security-reviewer",
      runCount: 0,
    })
  }))

test("Blueprint list metadata contains owner fields without loading document content", () =>
  inHome(async () => {
    const note = await NoteStore.create({
      title: "Metadata",
      kind: "blueprint",
      blueprint: {
        description: "Visible execution state",
        runCount: 1,
      },
    })
    await recordBlueprintNoteRun({ scopeID: "home", noteID: note.id, loopID: "blp_meta", started: 123 })
    const meta = (await NoteStore.listMeta("home")).find((entry) => entry.id === note.id)
    expect(meta?.blueprint).toEqual((await NoteStore.get("home", note.id)).blueprint)
    expect(meta?.blueprint?.activeLoopID).toBe("blp_meta")
    expect(meta).not.toHaveProperty("content")
  }))

test("Blueprint patches preserve other known and future owner fields", () =>
  inHome(async () => {
    const note = await NoteStore.create({
      title: "Retained metadata",
      kind: "blueprint",
      blueprint: {
        description: "Original",
        runCount: 1,
      },
    })
    await recordBlueprintNoteRun({ scopeID: "home", noteID: note.id, loopID: "blp_existing", started: 123 })
    const key = ["notes", "home", note.id]
    const current = await NoteStore.get("home", note.id)
    await Storage.write(key, { ...current, blueprint: { ...current.blueprint, future: { checkpoint: [1, 2] } } })
    const changed = await NoteStore.update("home", note.id, { blueprint: { description: "Updated" } })
    expect(changed.blueprint).toEqual({
      description: "Updated",
      activeLoopID: "blp_existing",
      activeLoopSource: "user",
      lastRunAt: 123,
      lastRunSource: "user",
      runCount: 2,
    })
    expect((await Storage.read<{ blueprint: Record<string, unknown> }>(key)).blueprint.future).toEqual({
      checkpoint: [1, 2],
    })
    const cleared = await NoteStore.update("home", note.id, { blueprint: { activeLoopID: null } })
    expect(cleared.blueprint?.activeLoopID).toBeUndefined()
    expect(cleared.blueprint?.activeLoopSource).toBeUndefined()
    expect(cleared.blueprint?.runCount).toBe(2)
  }))

test("Blueprint lifecycle updates note versions, metadata and archive state", () =>
  inHome(async () => {
    const note = await NoteStore.create({ title: "Executed Blueprint", kind: "blueprint" })
    await recordBlueprintNoteRun({ scopeID: "home", noteID: note.id, loopID: "blp_run", started: 123 })
    const started = await NoteStore.get("home", note.id)
    expect(started.version).toBe(note.version + 1)
    expect(started.blueprint).toEqual({
      activeLoopID: "blp_run",
      activeLoopSource: "user",
      runCount: 1,
      lastRunAt: 123,
      lastRunSource: "user",
    })
    await recordBlueprintNoteRun({ scopeID: "home", noteID: note.id, loopID: "blp_run", ended: true, archive: true })
    const ended = await NoteStore.get("home", note.id)
    expect(ended.version).toBe(note.version + 2)
    expect(ended.archived).toBe(true)
    expect(ended.blueprint).toEqual({ runCount: 1, lastRunAt: 123, lastRunSource: "user" })
    expect((await NoteStore.listMeta("home")).some((entry) => entry.id === note.id)).toBe(false)
  }))

test("Blueprint lifecycle does not mutate ordinary notes or require deleted documents", () =>
  inHome(async () => {
    const note = await NoteStore.create({ title: "Ordinary" })
    await recordBlueprintNoteRun({ scopeID: "home", noteID: note.id, loopID: "blp_unrelated", started: 123 })
    expect(await NoteStore.get("home", note.id)).toEqual(note)
    await recordBlueprintNoteRun({ scopeID: "home", noteID: "nte_missing", loopID: "blp_unrelated", ended: true })
  }))

test("converting a Blueprint to a plain note removes the known execution metadata", () =>
  inHome(async () => {
    const note = await NoteStore.create({ title: "Converted", kind: "blueprint", blueprint: { runCount: 3 } })
    const changed = await NoteStore.update("home", note.id, { kind: "note" })
    expect(changed.kind).toBe("note")
    expect(changed.blueprint).toBeUndefined()
    expect((await Storage.read<Record<string, unknown>>(["notes", "home", note.id])).blueprint).toBeUndefined()
  }))
