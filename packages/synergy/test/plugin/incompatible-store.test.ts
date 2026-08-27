import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { IncompatiblePluginStore } from "../../src/plugin/incompatible-store"
import { tmpdir } from "../fixture/fixture"

describe("incompatible plugin records", () => {
  test("round-trips records and removes all records owned by a plugin", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const records = [
      { pluginId: "focus", spec: "file:///focus-old.tgz", reason: "reinstallRequired" as const },
      { pluginId: "focus", spec: "file:///focus-older.tgz", reason: "reinstallRequired" as const },
      { pluginId: "other", spec: "file:///other.tgz", reason: "reinstallRequired" as const },
    ]

    await IncompatiblePluginStore.write(records, data)
    expect(await IncompatiblePluginStore.read(data)).toEqual(records)
    expect(IncompatiblePluginStore.withoutPlugin(records, "focus")).toEqual([records[2]])
    expect(IncompatiblePluginStore.withoutPlugin(records, "unknown", ["file:///other.tgz"])).toEqual([
      records[0],
      records[1],
    ])
  })

  test("returns an empty catalog only when the file is missing and rejects corrupt data", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    expect(await IncompatiblePluginStore.read(data)).toEqual([])
    await Bun.write(path.join(data, "plugin-incompatible.json"), "not json")
    await expect(IncompatiblePluginStore.read(data)).rejects.toThrow()
  })

  test("concurrent writes land exactly one complete batch without temp residue", async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const batches = Array.from({ length: 8 }, (_, index) => [
      { pluginId: `race-${index}`, reason: "reinstallRequired" as const },
    ])

    await Promise.all(batches.map((batch) => IncompatiblePluginStore.write(batch, data)))

    const final = await IncompatiblePluginStore.read(data)
    expect(final).toHaveLength(1)
    expect(batches.some((batch) => batch[0]!.pluginId === final[0]?.pluginId)).toBe(true)
    const entries = await fs.readdir(data)
    expect(entries.filter((name) => name.includes(".tmp"))).toEqual([])
  })
})
