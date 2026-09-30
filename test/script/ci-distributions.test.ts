import { expect, test } from "bun:test"
import { chmod, mkdtemp, readFile, rm, stat } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  distributionBuildIdentity,
  distributionPaths,
  publishDistribution,
  rebindDistribution,
  restoreDistribution,
} from "../../script/ci/distributions"
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
    await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
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

test("workflow transport preserves distribution modes across a consumer umask", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-distribution-transfer-"))
  const repository = path.resolve(import.meta.dir, "../..")
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "transfer",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [{ id: "artifact", kind: "artifacts", pool: "linux", owners: [], needs: [], seconds: 1 }],
  })
  async function command(args: string[]) {
    const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" })
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  }
  try {
    await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
    for (const profile of ["core", "full"] as const) {
      for (const prefix of distributionPaths(profile)) {
        await Bun.write(path.join(root, prefix, "fixture"), "transported executable")
        await chmod(path.join(root, prefix, "fixture"), 0o777)
      }
      await publishDistribution(root, plan, profile)
      await command([
        "tar",
        "--zstd",
        "-cf",
        `.artifacts/ci/distributions/${profile}.tar.zst`,
        "-C",
        ".artifacts/ci/distributions",
        profile,
      ])
      await rm(path.join(root, ".artifacts/ci/distributions", profile), { recursive: true })
      await command([
        "sh",
        "-c",
        'umask 077; exec "$@"',
        "ci-input",
        process.execPath,
        "-e",
        `import { unpackInput } from ${JSON.stringify(path.join(repository, "script/ci/github.ts"))}; await unpackInput(${JSON.stringify(path.join(root, `.artifacts/ci/distributions/${profile}.tar.zst`))}, ${JSON.stringify(path.join(root, ".artifacts/ci/distributions"))})`,
      ])
      await restoreDistribution(root, plan, profile)
      for (const prefix of distributionPaths(profile))
        expect((await stat(path.join(root, prefix, "fixture"))).mode & 0o777).toBe(0o777)
      for (const [workflow, job] of [["ci-diagnostic.yml", "execute"]]) {
        const parsed = Bun.YAML.parse(
          await readFile(path.join(repository, ".github/workflows", workflow!), "utf8"),
        ) as { jobs: Record<string, { steps: Array<{ name?: string; run?: string }> }> }
        const unpack = parsed.jobs[job!]!.steps.find((step) => step.name === `Unpack ${profile} distribution`)!.run!
        await rm(path.join(root, ".artifacts/ci/distributions", profile), { recursive: true })
        await command(["sh", "-c", `umask 077; ${unpack}`])
        await restoreDistribution(root, plan, profile)
        for (const prefix of distributionPaths(profile))
          expect((await stat(path.join(root, prefix, "fixture"))).mode & 0o777).toBe(0o777)
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cached distribution inputs are verified before issuing evidence for another plan", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-distribution-cache-"))
  const plan = createPlan({
    base: "a",
    head: "b",
    sha: "tested",
    run: "42",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks: [{ id: "artifact", kind: "artifacts", pool: "linux", owners: [], needs: [], seconds: 1 }],
  })
  try {
    await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
    for (const prefix of distributionPaths("full"))
      await Bun.write(path.join(root, prefix, "fixture"), "compiled fixture")
    await publishDistribution(root, plan, "full")
    const key = await distributionBuildIdentity(root, plan, "full")
    const next = { ...plan, run: "43", attempt: "2", digest: "new-plan" }
    await expect(restoreDistribution(root, next, "full")).rejects.toThrow("identity")
    await rebindDistribution(root, next, "full")
    await restoreDistribution(root, next, "full")
    expect(await distributionBuildIdentity(root, next, "full")).toBe(key)
    await expect(rebindDistribution(root, { ...next, sha: "another-sha" }, "full")).rejects.toThrow("inputs")
    await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "different native toolchain outputs")
    await expect(rebindDistribution(root, next, "full")).rejects.toThrow("inputs")
    await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
    await Bun.write(
      path.join(root, ".artifacts/ci/distributions/full", distributionPaths("full")[0]!, "fixture"),
      "corrupt",
    )
    await expect(rebindDistribution(root, next, "full")).rejects.toThrow("bytes")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
