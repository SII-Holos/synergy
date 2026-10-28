import { expect, test } from "bun:test"
import { runStability, stabilityFiles, stabilityOptions } from "../../script/stability"
import { mkdtemp, rm } from "node:fs/promises"
import path from "node:path"
import os from "node:os"

test("batch reproduction includes siblings and never silently starts a whole suite", () => {
  const batches = [{ files: ["a", "b"] }, { files: ["c"] }]
  expect(stabilityFiles(["a"], batches, false)).toEqual(["a"])
  expect(stabilityFiles(["a"], batches, true)).toEqual(["a", "b"])
  expect(() => stabilityFiles([], batches, true)).toThrow("explicit")
  expect(() => stabilityFiles(["missing"], batches, true)).toThrow("Unknown")
})

test("repeat and seed have bounded, reproducible integer values", () => {
  expect(stabilityOptions({ repeat: "3", seed: "42" })).toEqual({ repeat: 3, seed: 42 })
  for (const repeat of ["0", "-1", "1.5", "101", "abc"]) expect(() => stabilityOptions({ repeat })).toThrow("repeat")
  expect(() => stabilityOptions({ seed: "-1" })).toThrow("seed")
})

test("real repeated execution retains a failure even when the next fresh Home passes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "stability-regression-"))
  try {
    await Bun.write(path.join(root, "package.json"), JSON.stringify({ workspaces: { packages: [] } }))
    await Bun.write(
      path.join(root, "test/case.test.ts"),
      `
      import { test, expect } from "bun:test"
      test("target", () => {
        expect(process.env.SYNERGY_TEST_HOME).toBeTruthy()
        expect(process.env.SYNERGY_TEST_SEED).toBe("43")
      })
    `,
    )
    expect(await runStability(root, { tests: ["test/case.test.ts"], repeat: 2, seed: 42 })).toBe(false)
    const files = await Array.fromAsync(new Bun.Glob(".artifacts/verify/stability/*/report.json").scan({ cwd: root }))
    const report = await Bun.file(path.join(root, files[0]!)).json()
    expect(report.results.map((result: { exitCode: number }) => result.exitCode)).toEqual([1, 0])
    expect(await runStability(root, { tests: ["test/case.test.ts"], repeat: 1, seed: 43, name: "absent" })).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
