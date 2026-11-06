import { expect, test } from "bun:test"
import { cachedChecks } from "../../script/gates"
import { execFileSync } from "node:child_process"
import { chmod, mkdtemp, rm, symlink } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkingSnapshot, changedInputs, missingMeasurements, verificationToolchain } from "../../script/verification"

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "verification-"))
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim()
  git("init", "--quiet")
  git("config", "user.name", "Fixture")
  git("config", "user.email", "fixture@example.test")
  await Bun.write(path.join(root, ".gitignore"), ".artifacts/\nignored/\n")
  await Bun.write(path.join(root, "source.ts"), "export const value = 1\n")
  git("add", ".")
  git("commit", "--quiet", "-m", "fixture")
  return {
    root,
    git,
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true })
    },
  }
}

test("working inputs include staged, unstaged, removed and untracked files without changing the index", async () => {
  await using f = await fixture()
  const base = f.git("rev-parse", "HEAD")
  await Bun.write(path.join(f.root, "source.ts"), "export const value = 2\n")
  f.git("add", "source.ts")
  const index = f.git("write-tree")
  await Bun.write(path.join(f.root, "new.ts"), "export const next = true\n")
  await Bun.write(path.join(f.root, "ignored/secret"), "ignored")
  const snapshot = new WorkingSnapshot(f.root)
  expect(changedInputs(f.root, base, snapshot)).toEqual(["new.ts", "source.ts"])
  expect(snapshot.files).not.toContain("ignored/secret")
  await rm(path.join(f.root, "source.ts"))
  expect(changedInputs(f.root, base, new WorkingSnapshot(f.root))).toContain("source.ts")
  expect(f.git("write-tree")).toBe(index)
})

test("fingerprints bind bytes, new files and link targets, but not commit metadata or ignored artifacts", async () => {
  await using f = await fixture()
  const first = new WorkingSnapshot(f.root).digest
  f.git("commit", "--allow-empty", "--quiet", "-m", "metadata")
  await Bun.write(path.join(f.root, ".artifacts/result.json"), "{}")
  expect(new WorkingSnapshot(f.root).digest).toBe(first)
  await Bun.write(path.join(f.root, "source.ts"), "export const value = 2\n")
  expect(new WorkingSnapshot(f.root).digest).not.toBe(first)
  await symlink("source.ts", path.join(f.root, "link"))
  const linked = new WorkingSnapshot(f.root).digest
  await rm(path.join(f.root, "link"))
  await symlink("missing.ts", path.join(f.root, "link"))
  expect(new WorkingSnapshot(f.root).digest).not.toBe(linked)
})

test("static receipts reuse exact inputs and commands, never failures, corrupt records or edits during checks", async () => {
  await using f = await fixture()
  let calls = 0
  const execute = async () => {
    calls++
    return null
  }
  const gates = [{ id: "lint", run: "lint-v1", needs: [] }]
  await cachedChecks(f.root, gates, execute, "tool-v1")
  expect((await cachedChecks(f.root, gates, execute, "tool-v1")).reused).toEqual(["lint"])
  expect(calls).toBe(1)
  await cachedChecks(f.root, gates, execute, "tool-v2")
  await cachedChecks(f.root, [{ ...gates[0]!, run: "lint-v2" }], execute, "tool-v2")
  expect(calls).toBe(3)
  await Bun.write(path.join(f.root, ".artifacts/verify/checks.json"), "bad-json")
  await cachedChecks(f.root, gates, execute, "tool-v1")
  expect(calls).toBe(4)
  await Bun.write(path.join(f.root, "source.ts"), "changed")
  const changed = await cachedChecks(
    f.root,
    gates,
    async () => {
      await Bun.write(path.join(f.root, "source.ts"), "changed again")
      return null
    },
    "tool-v1",
  )
  expect(changed.failures.map((entry) => entry.gate)).toContain("inputs-changed")
  await cachedChecks(f.root, gates, async () => ({ gate: "lint", exitCode: 1, stderr: "failed" }), "tool-v1")
  expect((await cachedChecks(f.root, gates, execute, "tool-v1")).reused).toEqual([])
})

test("focused coverage requires measured source and respects only declared exact policy exemptions", () => {
  const files = ["src/new.ts", "src/old.ts", "src/browser.tsx"]
  const records = [
    { file: "src/old.ts", linesFound: 1, linesHit: 1, functionsFound: 0, functionsHit: 0, counts: new Map([[1, 1]]) },
  ]
  expect(missingMeasurements(files, records, [{ glob: "src/browser.tsx", reason: "Browser behavior suite" }])).toEqual([
    "src/new.ts",
  ])
})

test("local verification validates selection, stops on static failure and only then starts selected tests", async () => {
  await using f = await fixture()
  await Bun.write(path.join(f.root, "package.json"), JSON.stringify({ workspaces: { packages: [] } }))
  await Bun.write(path.join(f.root, "script/coverage-exempt.json"), JSON.stringify({ packages: {} }))
  await Bun.write(path.join(f.root, "script/check-bun-version.ts"), "export {}\n")
  await Bun.write(
    path.join(f.root, "test/selected.test.ts"),
    `import { test } from "bun:test"\nimport { appendFileSync } from "node:fs"\ntest("selected", () => appendFileSync(".artifacts/order.txt", "behavior\\n"))\n`,
  )
  f.git("add", ".")
  f.git("commit", "--quiet", "-m", "verification inputs")
  const run = async (file: string, fail: boolean) => {
    await Bun.write(path.join(f.root, ".artifacts/order.txt"), "")
    const child = Bun.spawn(
      [
        process.execPath,
        "--preload",
        path.join(import.meta.dir, "fixtures/verify-preflight.ts"),
        path.resolve(import.meta.dir, "../../script/verify.ts"),
        "local",
        "--base",
        "HEAD",
        "--test",
        file,
      ],
      {
        cwd: f.root,
        env: { ...process.env, VERIFY_FIXTURE_ROOT: f.root, VERIFY_FIXTURE_FAIL: fail ? "1" : "0" },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { exit, output: stdout + stderr, order: await Bun.file(path.join(f.root, ".artifacts/order.txt")).text() }
  }
  const invalid = await run("test/missing.test.ts", false)
  expect(invalid.exit).toBe(1)
  expect(invalid.output).toContain("Unknown test file")
  expect(invalid.order).toBe("")
  const failed = await run("test/selected.test.ts", true)
  expect(failed.exit).toBe(1)
  expect(failed.output).toContain("controlled static failure")
  expect(failed.order).toBe("static\n")
  const passed = await run("test/selected.test.ts", false)
  expect(passed.output).toContain("Selected local verification passed")
  expect(passed.exit).toBe(0)
  expect(passed.order).toBe("static\nbehavior\n")
}, 30_000)

test("hook PATH additions reuse the same tools, while an executable or semantic environment change invalidates receipts", async () => {
  await using f = await fixture()
  const extra = path.join(f.root, "ignored/tools")
  const first = verificationToolchain(f.root)
  const env = { ...process.env, PATH: `${extra}${path.delimiter}${process.env.PATH}` }
  expect(verificationToolchain(f.root, env)).toBe(first)
  const gates = [{ id: "lint", run: "lint", needs: [] }]
  await cachedChecks(f.root, gates, async () => null, first)
  expect((await cachedChecks(f.root, gates, async () => null, verificationToolchain(f.root, env))).reused).toEqual([
    "lint",
  ])
  await Bun.write(path.join(extra, "git"), "#!/bin/sh\nexit 0\n")
  await chmod(path.join(extra, "git"), 0o755)
  expect(verificationToolchain(f.root, env)).not.toBe(first)
  expect(verificationToolchain(f.root, { ...process.env, NODE_OPTIONS: "--no-warnings" })).not.toBe(first)
})
