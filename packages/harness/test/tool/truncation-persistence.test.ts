import { expect, test } from "bun:test"
import { storageTestRuntime } from "../support/storage-runtime"
import { Truncate } from "../../src/tool/truncation"

test("truncated output is published only after the selected durable store confirms it", async () => {
  const runtime = await storageTestRuntime()
  const stored = new Map<string, string>()
  let fail = false
  try {
    await runtime.run(async () => {
      Truncate.registerStorage({
        async save(id, text) {
          if (fail) throw new Error("output storage unavailable")
          stored.set(id, text)
          return { reference: `output://${id}`, instructions: "Read the exact output reference with read_output." }
        },
      })
      const text = "first\nsecond\nthird"
      const result = await Truncate.output(text, { maxLines: 1 })
      expect(result.truncated).toBe(true)
      if (!result.truncated) throw new Error("expected truncated output")
      expect(result.outputPath).toStartWith("output://")
      expect(stored.get(result.outputPath.slice("output://".length))).toBe(text)
      expect(result.content).toContain("read_output")
      fail = true
      await expect(Truncate.output(text, { maxLines: 1 })).rejects.toThrow("unavailable")
      expect(await Truncate.output("small")).toEqual({ content: "small", truncated: false })
    })
  } finally {
    await runtime.close()
  }
})
