import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  evaluatePackage,
  matchesExempt,
  mergeLcov,
  parseLcov,
  sourceUniverse,
  validateManifest,
  type CoverageManifest,
  type LcovRecord,
} from "../../script/coverage-check"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "synergy-coverage-check-"))
  roots.push(root)
  return root
}

function record(file: string, partial: Partial<LcovRecord> = {}): LcovRecord {
  return {
    file,
    linesFound: 10,
    linesHit: 9,
    functionsFound: 2,
    functionsHit: 2,
    counts: new Map([
      [1, 1],
      [2, 0],
    ]),
    ...partial,
  }
}

describe("coverage lcov parsing", () => {
  test("parses the Bun 1.3.14 lcov subset", () => {
    const source = [
      "TN:",
      "SF:src/example.ts",
      "FNF:2",
      "FNH:1",
      "DA:1,5",
      "DA:2,0",
      "LF:2",
      "LH:1",
      "end_of_record",
    ].join("\n")
    const records = parseLcov(source)
    expect(records).toHaveLength(1)
    expect(records[0]!.file).toBe("src/example.ts")
    expect(records[0]!.functionsFound).toBe(2)
    expect(records[0]!.functionsHit).toBe(1)
    expect(records[0]!.counts.get(1)).toBe(5)
    expect(records[0]!.counts.get(2)).toBe(0)
  })

  test("merges multiple batches per file with union semantics", () => {
    const batchA = [
      record("src/a.ts", {
        counts: new Map([
          [1, 1],
          [2, 0],
        ]),
      }),
    ]
    const batchB = [
      record("src/a.ts", {
        counts: new Map([
          [1, 0],
          [2, 3],
        ]),
      }),
    ]
    const merged = mergeLcov([batchA, batchB])
    expect(merged).toHaveLength(1)
    // Union semantics: a line hit in any batch counts as hit. Header totals
    // keep the max; linesHit is recomputed from the merged counts.
    expect(merged[0]!.linesFound).toBe(10)
    expect(merged[0]!.linesHit).toBe(2)
    expect(merged[0]!.counts.get(1)).toBe(1)
    expect(merged[0]!.counts.get(2)).toBe(3)
    expect(merged[0]!.functionsFound).toBe(2)
    expect(merged[0]!.functionsHit).toBe(2)
  })
})

describe("coverage exemption matching", () => {
  test("matches globs against relative paths", () => {
    const exempt = [
      { glob: "src/gen/**", reason: "generated code" },
      { glob: "src/**/types.ts", reason: "types only" },
    ]
    expect(matchesExempt("src/gen/sdk.gen.ts", exempt)?.glob).toBe("src/gen/**")
    expect(matchesExempt("src/some/deep/types.ts", exempt)?.glob).toBe("src/**/types.ts")
    expect(matchesExempt("src/logic.ts", exempt)).toBeNull()
  })
})

describe("coverage package evaluation", () => {
  const config = {
    command: "bun test --coverage",
    lcov: "coverage/lcov.info",
    thresholds: { lines: 80, functions: 75 },
    exempt: [] as Array<{ glob: string; reason: string }>,
  }

  test("passes when thresholds and completeness hold", () => {
    const verdict = evaluatePackage("pkg", config, ["src/a.ts", "src/b.ts"], [record("src/a.ts"), record("src/b.ts")])
    expect(verdict.passed).toBe(true)
    expect(verdict.missing).toBe(0)
  })

  test("fails when a source file is never loaded", () => {
    const verdict = evaluatePackage("pkg", config, ["src/a.ts", "src/b.ts"], [record("src/a.ts")])
    expect(verdict.passed).toBe(false)
    expect(verdict.missing).toBe(1)
  })

  test("fails when line coverage is below threshold", () => {
    const verdict = evaluatePackage("pkg", config, ["src/a.ts"], [record("src/a.ts", { linesFound: 10, linesHit: 7 })])
    expect(verdict.passed).toBe(false)
    expect(verdict.linesPct).toBeCloseTo(70)
  })

  test("exempted files are excluded from the universe", () => {
    const verdict = evaluatePackage(
      "pkg",
      { ...config, exempt: [{ glob: "src/gen/**", reason: "generated code" }] },
      ["src/a.ts", "src/gen/sdk.gen.ts"],
      [record("src/a.ts")],
    )
    expect(verdict.passed).toBe(true)
    expect(verdict.exempted).toBe(1)
  })

  test("reports uncovered lines", () => {
    const verdict = evaluatePackage("pkg", config, ["src/a.ts"], [record("src/a.ts")])
    expect(verdict.uncovered).toEqual([{ file: "src/a.ts", lines: [2] }])
  })

  test("sorts never-loaded files before zero-line files", () => {
    const verdict = evaluatePackage("pkg", config, ["src/a.ts", "src/b.ts"], [record("src/a.ts")])
    expect(verdict.missing).toBe(1)
    expect(verdict.uncovered[0]).toEqual({ file: "src/b.ts", lines: [] })
    expect(verdict.uncovered[1]).toEqual({ file: "src/a.ts", lines: [2] })
  })
})

describe("coverage manifest validation", () => {
  test("rejects exemptions without reasons", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "packages/pkg/src"), { recursive: true })
    await writeFile(path.join(root, "packages/pkg/src/a.ts"), "export const a = 1\n")
    const manifest: CoverageManifest = {
      packages: {
        "packages/pkg": {
          command: "bun test",
          lcov: "coverage/lcov.info",
          thresholds: { lines: 80, functions: 75 },
          exempt: [{ glob: "src/a.ts", reason: "" }],
        },
      },
    }
    const errors = await validateManifest(manifest, root)
    expect(errors.some((error) => error.includes("has no reason"))).toBe(true)
  })

  test("rejects exemptions matching nothing", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "packages/pkg/src"), { recursive: true })
    await writeFile(path.join(root, "packages/pkg/src/a.ts"), "export const a = 1\n")
    const manifest: CoverageManifest = {
      packages: {
        "packages/pkg": {
          command: "bun test",
          lcov: "coverage/lcov.info",
          thresholds: { lines: 80, functions: 75 },
          exempt: [{ glob: "src/missing/**", reason: "not real" }],
        },
      },
    }
    const errors = await validateManifest(manifest, root)
    expect(errors.some((error) => error.includes("matches no source files"))).toBe(true)
  })

  test("rejects overlapping exemptions", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "packages/pkg/src/sub"), { recursive: true })
    await writeFile(path.join(root, "packages/pkg/src/sub/a.ts"), "export const a = 1\n")
    const manifest: CoverageManifest = {
      packages: {
        "packages/pkg": {
          command: "bun test",
          lcov: "coverage/lcov.info",
          thresholds: { lines: 80, functions: 75 },
          exempt: [
            { glob: "src/sub/**", reason: "generated" },
            { glob: "src/sub/a.ts", reason: "redundant" },
          ],
        },
      },
    }
    const errors = await validateManifest(manifest, root)
    expect(errors.some((error) => error.includes("matches multiple exemptions"))).toBe(true)
  })

  test("rejects a single exemption wider than 25% of the package", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "packages/pkg/src"), { recursive: true })
    for (const file of ["a.ts", "b.ts", "c.ts", "d.ts"]) {
      await writeFile(path.join(root, "packages/pkg/src", file), "export const x = 1\n")
    }
    const manifest: CoverageManifest = {
      packages: {
        "packages/pkg": {
          command: "bun test",
          lcov: "coverage/lcov.info",
          thresholds: { lines: 80, functions: 75 },
          exempt: [{ glob: "src/**", reason: "too broad" }],
        },
      },
    }
    const errors = await validateManifest(manifest, root)
    expect(errors.some((error) => error.includes("too broad"))).toBe(true)
  })
})

describe("coverage source universe", () => {
  test("collects ts and tsx under src only", async () => {
    const root = await fixture()
    await mkdir(path.join(root, "packages/pkg/src/nested"), { recursive: true })
    await mkdir(path.join(root, "packages/pkg/test"), { recursive: true })
    await mkdir(path.join(root, "packages/pkg/src/node_modules"), { recursive: true })
    await writeFile(path.join(root, "packages/pkg/src/a.ts"), "1\n")
    await writeFile(path.join(root, "packages/pkg/src/nested/b.tsx"), "2\n")
    await writeFile(path.join(root, "packages/pkg/src/README.md"), "3\n")
    await writeFile(path.join(root, "packages/pkg/test/c.test.ts"), "4\n")
    await writeFile(path.join(root, "packages/pkg/src/node_modules/d.ts"), "5\n")
    const universe = await sourceUniverse(path.join(root, "packages/pkg"), ["src/**/*.ts", "src/**/*.tsx"])
    expect(universe).toEqual(["src/a.ts", "src/nested/b.tsx"])
  })
})
