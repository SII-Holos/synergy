import { expect, test } from "bun:test"
import { mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { shadowEvidence } from "../../script/ci/rollout"
import { verifyReport } from "../../script/ci/evidence"
import { createPlan, hash } from "../../script/ci/plan"

test("shadow evidence exposes a missed failure without replacing current execution", () => {
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "shadow",
    changed: ["README.md"],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [
      { id: "policy", kind: "policy", pool: "linux", seconds: 1, owners: [], needs: [] },
      { id: "runtime", kind: "postgres", pool: "postgres", seconds: 1, owners: [], needs: [] },
    ],
  })
  const result = {
    version: 2 as const,
    task: "runtime",
    unit: plan.units.find((unit) => unit.tasks.includes("runtime"))!.id,
    plan: plan.digest,
    sha: plan.sha,
    run: plan.run,
    planAttempt: plan.attempt,
    executionAttempt: plan.attempt,
    mode: plan.mode,
    status: "failure" as const,
    exitCode: 1,
    started: "2026-09-27T00:00:00Z",
    completed: "2026-09-27T00:00:02Z",
    reports: [],
    steps: [],
  }
  const evidence = shadowEvidence(plan, [result], false, "selector")
  expect(evidence.misses).toEqual(["runtime"])
  expect(evidence.passed).toBe(false)
  expect(evidence.taskSeconds).toBe(2)
  expect(evidence.selectedSeconds).toBe(0)
  expect(evidence.policy).toBe("selector")
  expect(evidence.catalog).toBe(hash(plan.tasks))
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
