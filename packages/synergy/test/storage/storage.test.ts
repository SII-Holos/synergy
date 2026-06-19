import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

function testKey(name: string) {
  return ["test-storage", `${Date.now()}-${Math.random().toString(36).slice(2)}`, name]
}

describe("storage", () => {
  test("write and update persist JSON through the storage API without temp leftovers", async () => {
    const key = testKey("record")
    const target = path.join(Global.Path.data, ...key) + ".json"

    await Storage.write(key, { count: 1 })
    await Storage.update<{ count: number }>(key, (draft) => {
      draft.count += 1
    })

    expect(await Storage.read<{ count: number }>(key)).toEqual({ count: 2 })
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ count: 2 })
    expect((await fs.readdir(path.dirname(target))).some((entry) => entry.endsWith(".tmp"))).toBe(false)
  })

  test("scan and list ignore storage temp files", async () => {
    const key = testKey("record")
    const prefix = key.slice(0, -1)
    const dir = path.join(Global.Path.data, ...prefix)

    await Storage.write(key, { ok: true })
    await fs.writeFile(path.join(dir, ".record.json.123.tmp"), '{"partial":')

    expect(await Storage.scan(prefix)).toEqual(["record"])
    expect(await Storage.list(prefix)).toEqual([key])
  })
})
