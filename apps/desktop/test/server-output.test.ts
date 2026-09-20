import { expect, test } from "bun:test"
import { ManagedServerOutput } from "../src/server-output.js"

test("keeps a bounded per-launch tail and decodes interleaved split UTF-8 streams", () => {
  const stdout: string[] = []
  const output = new ManagedServerOutput((text) => stdout.push(text))
  output.receive("stdout", Buffer.from("old".repeat(8192)))
  const bytes = Buffer.from("进度🙂\n")
  for (let i = 0; i < bytes.length; i++) {
    output.receive("stdout", bytes.subarray(i, i + 1))
    output.receive("stderr", bytes.subarray(i, i + 1))
  }
  expect(stdout.join("")).toEndWith("进度🙂\n")
  expect(output.details.length).toBeLessThanOrEqual(8192)
  expect(output.details).not.toContain("�")
  expect(output.portConflict).toBe(false)
  output.receive("stderr", Buffer.from("Failed to start server on port 12345"))
  expect(output.portConflict).toBe(true)
  expect(new ManagedServerOutput(() => {}).details).toBe("")
})
