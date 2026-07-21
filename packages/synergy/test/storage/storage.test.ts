import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Storage } from "../../src/storage/storage"

function keyRoot() {
  return ["storage-test", Math.random().toString(36).slice(2)]
}

describe("Storage", () => {
  test("atomic write and update do not leave scannable temp files", async () => {
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
  })

  test("compact writes omit pretty-print indentation but read back identically", async () => {
    const root = keyRoot()
    const content = { value: 1, nested: { a: [1, 2, 3] } }

    await Storage.write([...root, "pretty"], content)
    await Storage.write([...root, "compact"], content, { compact: true })

    const dir = path.join(Global.Path.data, ...root)
    const prettyRaw = await fs.readFile(path.join(dir, "pretty.json"), "utf8")
    const compactRaw = await fs.readFile(path.join(dir, "compact.json"), "utf8")

    expect(prettyRaw).toContain("\n")
    expect(compactRaw).not.toContain("\n")
    expect(compactRaw.length).toBeLessThan(prettyRaw.length)

    // Both forms parse to the same value.
    expect(await Storage.read<typeof content>([...root, "pretty"])).toEqual(content)
    expect(await Storage.read<typeof content>([...root, "compact"])).toEqual(content)

    // update honors the compact option too.
    await Storage.update<typeof content>([...root, "compact"], (draft) => (draft.value = 2), { compact: true })
    const updatedRaw = await fs.readFile(path.join(dir, "compact.json"), "utf8")
    expect(updatedRaw).not.toContain("\n")
    expect(await Storage.read<typeof content>([...root, "compact"])).toEqual({ value: 2, nested: { a: [1, 2, 3] } })
  })
})
