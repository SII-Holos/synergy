import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { readRecord, readRecordSnapshot, writeRecord } from "../src/record"

test("organization identity readers reject a symbolic link instead of importing foreign native material", async () => {
  await using temporary = await tmpdir()
  const external = path.join(temporary.path, "external.json")
  const root = path.join(temporary.path, "home")
  await fs.mkdir(root)
  await writeRecord(external, { private: "foreign" })
  await fs.symlink(external, path.join(root, "identity.json"))
  await expect(
    readRecord(path.join(root, "identity.json"), z.object({ private: z.string() }), "identity"),
  ).rejects.toThrow("regular")
})

test("a native record snapshot returns exact bytes and preserves original cancellation through descriptor cleanup", async () => {
  await using temporary = await tmpdir()
  const filename = path.join(temporary.path, "identity.json")
  const raw = '{ "value" : "original" }\n'
  await fs.writeFile(filename, raw)
  const schema = z.object({ value: z.string() })
  const result = await readRecordSnapshot(filename, schema, "identity")
  expect(Buffer.from(result!.bytes).toString()).toBe(raw)
  expect(result!.value).toEqual({ value: "original" })
  const original = fs.open.bind(fs)
  const controller = new AbortController()
  const reason = new Error("original native capture cancelled")
  let closed = false
  const open = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args)
    const close = file.close.bind(file)
    file.close = async () => {
      closed = true
      await close()
    }
    controller.abort(reason)
    return file
  })
  try {
    await expect(readRecordSnapshot(filename, schema, "identity", { signal: controller.signal })).rejects.toBe(reason)
    expect(closed).toBe(true)
  } finally {
    open.mockRestore()
  }
})

test("a native record snapshot rejects pathname replacement while its original descriptor remains readable", async () => {
  await using temporary = await tmpdir()
  const filename = path.join(temporary.path, "identity.json")
  await writeRecord(filename, { value: "original" })
  const original = fs.open.bind(fs)
  const open = spyOn(fs, "open").mockImplementation(async (...args) => {
    const file = await original(...args)
    await fs.rename(filename, filename + ".old")
    await fs.writeFile(filename, '{"value":"replaced"}\n')
    return file
  })
  try {
    await expect(readRecord(filename, z.object({ value: z.string() }), "identity")).rejects.toThrow("changed")
  } finally {
    open.mockRestore()
  }
})

test("organization identity readers reject a linked parent with an otherwise ordinary record", async () => {
  await using temporary = await tmpdir()
  const external = path.join(temporary.path, "external")
  await fs.mkdir(external)
  await writeRecord(path.join(external, "identity.json"), { value: "foreign" })
  await fs.symlink(external, path.join(temporary.path, "linked"))
  await expect(
    readRecord(path.join(temporary.path, "linked", "identity.json"), z.object({ value: z.string() }), "identity"),
  ).rejects.toThrow("regular")
})
