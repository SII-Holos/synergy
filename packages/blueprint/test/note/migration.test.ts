import { expect, test } from "bun:test"
import { testRuntime as coreRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { NoteMarkdown, NoteStore } from "@ericsanchezok/synergy-note"
import { registerNote } from "@ericsanchezok/synergy-note/register"
import { blueprintNoteMigrations } from "../../src/note-migration"
import { testRuntime } from "./runtime"

const legacy = (id: string) => ({
  id,
  title: "Retained Blueprint",
  kind: "blueprint",
  contentText: "# Legacy plan",
  pinned: false,
  global: true,
  tags: [],
  version: 1,
  time: { created: 1, updated: 1 },
  blueprint: { status: "ready", defaultAgent: "synergy-max", runCount: 3, future: { scopeID: "global" } },
  futureOwner: { id: "global", scopeID: "global" },
})

test("late Blueprint installation uses its own receipt and uninstall/reinstall preserves unknown data", async () => {
  await using tmp = await tmpdir()
  const key = ["notes", "global", "nte_legacy"]
  const plain = await coreRuntime({ home: tmp.path, composition: { register: registerNote } })
  try {
    await plain.run(async () => {
      await Storage.write(key, legacy(key[2]))
      await Storage.write(
        ["meta", "migration", "log-note"],
        Object.fromEntries(
          [
            "20260617-note-drop-contentText",
            "20260623-note-add-blueprint-fields",
            "20260623-note-rebuild-blueprint-meta",
            "20260624-note-remove-blueprint-status",
            "20260624-note-rebuild-expanded-preview-html",
            "20260624-note-rebuild-rich-preview-html",
            "20260626-note-add-block-ids",
            "20260704-note-add-archived",
            "20261002-note-primary-agent-identities",
          ].map((id) => [id, 42]),
        ),
      )
      expect(await NoteStore.listMeta("global")).toEqual([])
      expect(await Storage.read<Record<string, unknown>>(key)).toEqual(legacy(key[2]))
    })
  } finally {
    await plain.close()
  }
  const enabled = await testRuntime({ home: tmp.path })
  let upgraded: Record<string, unknown> = {}
  try {
    await enabled.run(async () => {
      const note = await NoteStore.get("home", key[2])
      expect(NoteMarkdown.toMarkdown(note.content).trim()).toBe("# Legacy plan")
      expect(note.blueprint?.defaultAgent).toBe("forge")
      expect(note.blueprint?.runCount).toBe(3)
      expect(
        (await Storage.read<Record<string, number>>(["meta", "migration", "log-blueprint-note"]))[
          blueprintNoteMigrations[0].id
        ],
      ).toBeGreaterThan(0)
      upgraded = await Storage.read<Record<string, unknown>>(["notes", "home", key[2]])
      expect((upgraded as Record<string, unknown>).futureOwner).toEqual(legacy(key[2]).futureOwner)
    })
  } finally {
    await enabled.close()
  }
  const absent = await coreRuntime({ home: tmp.path, composition: { register: registerNote } })
  try {
    await absent.run(async () => {
      expect(await NoteStore.listMeta("home")).toEqual([])
      await expect(NoteStore.get("home", key[2])).rejects.toBeInstanceOf(Storage.NotFoundError)
      expect(await Storage.read<Record<string, unknown>>(["notes", "home", key[2]])).toEqual(upgraded)
    })
  } finally {
    await absent.close()
  }
  const restored = await testRuntime({ home: tmp.path })
  try {
    await restored.run(async () => {
      expect((await NoteStore.listMeta("home"))[0].id).toBe(key[2])
      expect(await Storage.read<Record<string, unknown>>(["notes", "home", key[2]])).toEqual(upgraded)
    })
  } finally {
    await restored.close()
  }
})

test("interrupted Blueprint conversion invalidates committed indexes and retries without changing unknown fields", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const key = ["notes", "home", "nte_interrupted"]
    await Storage.write(key, legacy(key[2]))
    await Storage.write(["notes", "home", "_index"], [{ stale: true }])
    const migration = blueprintNoteMigrations[0]
    await expect(
      migration.up(() => {
        throw new Error("interrupted")
      }),
    ).rejects.toThrow("interrupted")
    expect((await Storage.readMany([["notes", "home", "_index"]]))[0]).toBeUndefined()
    await migration.up(() => {})
    const once = await Storage.read<Record<string, unknown>>(key)
    await migration.up(() => {})
    expect(await Storage.read<Record<string, unknown>>(key)).toEqual(once)
    expect(once.futureOwner).toEqual(legacy(key[2]).futureOwner)
    expect((once.blueprint as Record<string, unknown>).future).toEqual(legacy(key[2]).blueprint.future)
  })
})
