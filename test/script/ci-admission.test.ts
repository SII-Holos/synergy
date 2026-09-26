import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { rolloutErrors, type ShadowEvidence } from "../../script/ci/rollout"
import { verifyReport } from "../../script/ci/evidence"
import { hash } from "../../script/ci/plan"

function samples(): ShadowEvidence[] {
  const changed = [
    "docs/research/ci.md",
    "apps/web/src/app.ts",
    "packages/harness/src/storage/storage.ts",
    "benchmark/runtime/capture.mjs",
    "script/ci.ts",
  ]
  return Array.from({ length: 20 }, (_, index) => ({
    version: 1,
    policy: "policy",
    run: String(index),
    sha: hash(index),
    base: "base",
    mode: "shadow",
    passed: true,
    misses: [],
    changed: [changed[index % changed.length]!],
    taskSeconds: 100,
    selectedSeconds: 20,
  }))
}

test("affected admission needs 20 distinct full commits, change classes, and no unselected failures", () => {
  expect(rolloutErrors(samples(), "policy")).toEqual([])
  expect(rolloutErrors(samples().slice(1), "policy").length).toBeGreaterThan(0)
  expect(rolloutErrors(samples(), "changed-policy").length).toBeGreaterThan(0)
  expect(
    rolloutErrors(
      samples().map((sample) => ({ ...sample, sha: "same" })),
      "policy",
    ).length,
  ).toBeGreaterThan(0)
  expect(
    rolloutErrors(
      samples().map((sample) => ({ ...sample, mode: "diagnostic" })),
      "policy",
    ).length,
  ).toBeGreaterThan(0)
  expect(
    rolloutErrors(
      samples().map((sample) => ({ ...sample, changed: ["docs/research/ci.md"] })),
      "policy",
    ).length,
  ).toBeGreaterThan(0)
  expect(
    rolloutErrors([...samples(), { ...samples()[0]!, passed: false, misses: ["downstream-test"] }], "policy"),
  ).toContain("Shadow execution found unselected failures")
})

test("report verification rejects changed bytes, traversal and escaped symlinks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-evidence-"))
  try {
    const bytes = "fresh report"
    await Bun.write(path.join(root, "reports/test.xml"), bytes)
    const report = {
      path: "reports/test.xml",
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      kind: "junit" as const,
    }
    expect(Buffer.from(await verifyReport(root, report)).toString()).toBe(bytes)
    await Bun.write(path.join(root, "reports/test.xml"), "old report")
    await expect(verifyReport(root, report)).rejects.toThrow("checksum")
    await expect(verifyReport(root, { ...report, path: "../outside" })).rejects.toThrow("escapes")
    await symlink(os.tmpdir(), path.join(root, "escape"))
    await expect(verifyReport(root, { ...report, path: "escape" })).rejects.toThrow("escapes")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
