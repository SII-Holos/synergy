import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import { tmpdir } from "./fixture"

describe("tmpdir isolation guard", () => {
  test("throws when SYNERGY_TEST_ROOT is unset", async () => {
    const previous = process.env["SYNERGY_TEST_ROOT"]
    delete process.env["SYNERGY_TEST_ROOT"]
    try {
      await expect(tmpdir()).rejects.toThrow(/SYNERGY_TEST_ROOT/)
    } finally {
      if (previous === undefined) delete process.env["SYNERGY_TEST_ROOT"]
      else process.env["SYNERGY_TEST_ROOT"] = previous
    }
  })

  test("creates a fixture when SYNERGY_TEST_ROOT is set", async () => {
    const realRoot = await fs.realpath(process.env["SYNERGY_TEST_ROOT"]!)
    await using tmp = await tmpdir()
    expect(tmp.path.startsWith(realRoot)).toBe(true)
  })
})
