import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"

test("directory navigation pages every child and keeps hidden folders opt-in", async () => {
  await using tmp = await tmpdir({
    init: async (root) => {
      await Promise.all(["alpha", "beta", "gamma", ".hidden"].map((name) => fs.mkdir(path.join(root, name))))
      await Bun.write(path.join(root, "file.txt"), "file")
    },
  })
  const first = await File.directories({ path: tmp.path, limit: 2 })
  expect(first.entries.map((entry) => entry.name)).toEqual(["alpha", "beta"])
  expect(first.nextCursor).toBeTruthy()
  const next = await File.directories({ path: tmp.path, limit: 2, cursor: first.nextCursor })
  expect(next.entries.map((entry) => entry.name)).toEqual(["gamma"])
  expect(next.nextCursor).toBeUndefined()
  expect((await File.directories({ path: tmp.path, hidden: true })).entries.map((entry) => entry.name)).toContain(
    ".hidden",
  )
  await expect(File.directories({ path: tmp.path, hidden: true, cursor: first.nextCursor })).rejects.toMatchObject({
    data: { code: "invalid_cursor" },
  })
})

test("missing path, file path and empty directory have distinct results", async () => {
  await using tmp = await tmpdir()
  expect((await File.directories({ path: tmp.path })).entries).toEqual([])
  await expect(File.directories({ path: path.join(tmp.path, "missing") })).rejects.toMatchObject({
    data: { code: "not_found" },
  })
  await Bun.write(path.join(tmp.path, "file"), "file")
  await expect(File.directories({ path: path.join(tmp.path, "file") })).rejects.toMatchObject({
    data: { code: "not_directory" },
  })
})
