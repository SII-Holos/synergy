import { expect, test } from "bun:test"
import { chmod, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { distributionPaths, publishDistribution, restoreDistribution } from "../../script/ci/distributions"
import { createPlan } from "../../script/ci/plan"

test("shared distributions preserve executable bytes and reject foreign or changed artifacts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-distribution-"))
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "42",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [{ id: "artifact", kind: "artifacts", pool: "linux", owners: [], needs: [], seconds: 1 }],
  })
  try {
    for (const profile of ["core", "full"] as const) {
      for (const prefix of distributionPaths(profile)) {
        const file = path.join(root, prefix, "fixture")
        await Bun.write(file, "published executable")
        await chmod(file, 0o755)
      }
      await publishDistribution(root, plan, profile)
      for (const prefix of distributionPaths(profile)) await rm(path.join(root, prefix), { recursive: true })
      await restoreDistribution(root, plan, profile)
      expect(await Bun.file(path.join(root, distributionPaths(profile)[0]!, "fixture")).text()).toBe(
        "published executable",
      )
      await expect(restoreDistribution(root, { ...plan, attempt: "2" }, profile)).rejects.toThrow("identity")
      const file = path.join(root, ".artifacts/ci/distributions", profile, distributionPaths(profile)[0]!, "fixture")
      await chmod(file, 0o644)
      await expect(restoreDistribution(root, plan, profile)).rejects.toThrow("permissions")
      await chmod(file, 0o755)
      await Bun.write(file, "corrupted")
      await expect(restoreDistribution(root, plan, profile)).rejects.toThrow("bytes")
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
