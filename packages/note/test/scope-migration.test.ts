import { expect, test } from "bun:test"
import { testRuntime as coreRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { Storage } from "@ericsanchezok/synergy-harness/storage/storage"
import { migrations } from "../src/migration"
import { testRuntime } from "./support/runtime"

const id = "20261012-note-home-scope"

test("late Note installation migrates its documents despite a completed shared Scope receipt", async () => {
  await using tmp = await tmpdir()
  const core = await coreRuntime({ home: tmp.path })
  const ordinary = { id: "nte_plain", kind: "note", originScope: "global", futureOwner: { scopeID: "global" } }
  const blueprint = { id: "nte_blueprint", kind: "blueprint", blueprint: { future: { scopeID: "global" } } }
  try {
    await core.run(async () => {
      await Storage.write(["notes", "global", ordinary.id], ordinary)
      await Storage.write(["notes", "global", blueprint.id], blueprint)
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
    })
  } finally {
    await core.close()
  }
  const enabled = await testRuntime({ home: tmp.path })
  try {
    await enabled.run(async () => {
      expect(await Storage.read<Record<string, unknown>>(["notes", "home", ordinary.id])).toEqual({
        ...ordinary,
        originScope: "home",
      })
      expect(await Storage.read<Record<string, unknown>>(["notes", "global", blueprint.id])).toEqual(blueprint)
      expect((await Storage.read<Record<string, number>>(["meta", "migration", "log-note"]))[id]).toBeGreaterThan(0)
    })
  } finally {
    await enabled.close()
  }
})

test("Note scope catch-up never replaces a different destination record", async () => {
  await using runtime = await testRuntime()
  await runtime.run(async () => {
    const migration = migrations.find((migration) => migration.id === id)
    expect(migration).toBeDefined()
    const source = { id: "nte_conflict", kind: "note", title: "legacy" }
    const destination = { ...source, title: "current" }
    await Storage.write(["notes", "global", source.id], source)
    await Storage.write(["notes", "home", source.id], destination)
    await expect(migration!.up(() => {})).rejects.toThrow("conflict")
    expect(await Storage.read<Record<string, unknown>>(["notes", "global", source.id])).toEqual(source)
    expect(await Storage.read<Record<string, unknown>>(["notes", "home", source.id])).toEqual(destination)
  })
})
