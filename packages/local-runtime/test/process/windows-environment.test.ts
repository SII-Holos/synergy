import { expect, test } from "bun:test"
import { WindowsJob } from "../../src/process/windows-job"

test("Windows native environment preserves Unicode values, empty entries and an empty block", () => {
  expect(WindowsJob.environmentBlock({ zebra: "组织=✓", Alpha: "", beta: "two" }).toString("utf16le")).toBe(
    "Alpha=\0beta=two\0zebra=组织=✓\0\0",
  )
  expect(WindowsJob.environmentBlock({})).toEqual(Buffer.alloc(4))
})

test("Windows native environment rejects ambiguous or injected variables without exposing values", () => {
  const invalid: Record<string, string>[] = [
    { Path: "first", PATH: "second" },
    { "": "private" },
    { "bad=name": "private" },
    { "bad\0name": "private" },
    { NAME: "private\0injected=value" },
  ]
  for (const values of invalid) {
    expect(() => WindowsJob.environmentBlock(values)).toThrow(/Windows worker environment/)
  }
})
