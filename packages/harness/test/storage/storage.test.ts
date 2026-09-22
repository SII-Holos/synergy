import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

function keyRoot() {
  return ["storage-test", Math.random().toString(36).slice(2)]
}

describe("Storage", () => {
  test("atomic write and update do not leave scannable temp files", () =>
    runtime.run(async () => {
      const root = keyRoot()
      await Storage.write([...root, "item"], { value: 1 })
      await Storage.update<{ value: number }>([...root, "item"], (draft) => {
        draft.value = 2
      })

      const dir = path.join(Global.Path.data, ...root)
      await fs.mkdir(dir, { recursive: true })
      await Bun.write(path.join(dir, "leftover.json.tmp-123"), "{}")
      await Bun.write(path.join(dir, "another.tmp"), "{}")

      expect(await Storage.scan(root)).toEqual(["item"])
      expect(await Storage.list(root)).toEqual([[...root, "item"]])
      expect(await Storage.read<{ value: number }>([...root, "item"])).toEqual({ value: 2 })
    }))

  test("keeps nested data in the database without creating a JSON mirror", () =>
    runtime.run(async () => {
      const root = keyRoot()
      const content = { value: 1, nested: { a: [1, 2, 3] } }
      await Storage.write([...root, "record"], content)
      expect(await Storage.read<typeof content>([...root, "record"])).toEqual(content)
      expect(await Bun.file(path.join(Global.Path.data, ...root, "record.json")).exists()).toBe(false)
      await Storage.update<typeof content>([...root, "record"], (draft) => {
        draft.value = 2
      })
      expect(await Storage.read<typeof content>([...root, "record"])).toEqual({ ...content, value: 2 })
    }))
})

afterRuntimeTests(() => runtime.close())
