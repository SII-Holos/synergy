import { expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "node:path"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../support/fixture"

test("concurrent atomic writes preserve the previous record until promotion and leave no temporary files", async () => {
  await using directory = await tmpdir()
  const root = path.join(directory.path, "atomic")
  const target = path.join(root, "registry.json")
  await Storage.writeJsonAtomic(target, JSON.stringify({ value: "previous" }))
  const staged = Promise.withResolvers<void>()
  const promote = Promise.withResolvers<void>()
  const rename = fs.rename.bind(fs)
  let arrivals = 0
  using _rename = spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === target) {
      if (++arrivals === 8) staged.resolve()
      await promote.promise
    }
    return rename(from, to)
  })
  const values = Array.from({ length: 8 }, (_, value) => ({ value }))
  const writes = Promise.all(values.map((value) => Storage.writeJsonAtomic(target, JSON.stringify(value))))
  try {
    await Promise.race([staged.promise, writes])
    expect(JSON.parse(await fs.readFile(target, "utf8"))).toEqual({ value: "previous" })
  } finally {
    promote.resolve()
    await writes
  }
  expect(values).toContainEqual(JSON.parse(await fs.readFile(target, "utf8")))
  expect(await fs.readdir(root)).toEqual(["registry.json"])
})
