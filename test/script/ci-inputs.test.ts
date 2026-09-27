import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { cp, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { taskInputs } from "../../script/ci/inputs"
import { workspaceInputs } from "../../script/ci/catalog"
import { createPlan, type Task, type WorkspaceInput } from "../../script/ci/plan"

test("integration inputs follow both revisions, resources and unresolved dynamic imports", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-inputs-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI Fixture",
        GIT_AUTHOR_EMAIL: "ci@fixture.test",
        GIT_COMMITTER_NAME: "CI Fixture",
        GIT_COMMITTER_EMAIL: "ci@fixture.test",
      },
    }).trim()
  const workspaces: WorkspaceInput[] = [
    { directory: "packages/core", name: "core", dependencies: [], testDependencies: [] },
  ]
  const tasks: Task[] = [
    { id: "policy", kind: "policy", pool: "linux", owners: [], needs: [], seconds: 1 },
    {
      id: "pressure",
      kind: "rollout",
      pool: "linux",
      owners: ["packages/core"],
      needs: [],
      seconds: 1,
      inputs: ["packages/core/test/pressure.test.ts"],
    },
  ]
  try {
    git("init", "--quiet")
    await Bun.write(
      path.join(root, "packages/core/test/pressure.test.ts"),
      'import { value } from "../src/value"; new URL("./fixture.json", import.meta.url); export { value }',
    )
    await Bun.write(path.join(root, "packages/core/src/value.ts"), "export const value = 1")
    await Bun.write(path.join(root, "packages/core/src/unrelated.ts"), "export const unrelated = 1")
    await Bun.write(path.join(root, "packages/core/test/fixture.json"), "{}")
    git("add", ".")
    git("commit", "--quiet", "-m", "fixture base")
    const base = git("rev-parse", "HEAD")
    const before = await taskInputs(root, base, tasks, workspaces)
    expect(before.pressure!.complete).toBe(true)
    expect(before.pressure!.files).toContain("packages/core/src/value.ts")
    expect(before.pressure!.files).toContain("packages/core/test/fixture.json")
    const plan = (changed: string[], headInputs = before) =>
      createPlan({
        base,
        head: base,
        sha: base,
        run: "fixture",
        mode: "affected",
        changed,
        tasks,
        baseWorkspaces: workspaces,
        headWorkspaces: workspaces,
        baseInputs: before,
        headInputs,
      })
    expect(plan(["packages/core/src/unrelated.ts"]).selected).toEqual(["policy"])
    expect(plan(["packages/core/test/fixture.json"]).selected).toContain("pressure")
    await Bun.write(path.join(root, "packages/core/test/pressure.test.ts"), "export {}")
    git("add", ".")
    git("commit", "--quiet", "-m", "remove import")
    const after = await taskInputs(root, git("rev-parse", "HEAD"), tasks, workspaces)
    expect(after.pressure!.files).not.toContain("packages/core/src/value.ts")
    expect(plan(["packages/core/src/value.ts"], after).selected).toContain("pressure")
    await Bun.write(path.join(root, "packages/core/test/pressure.test.ts"), "await import(process.env.INPUT!)")
    git("add", ".")
    git("commit", "--quiet", "-m", "dynamic import")
    const dynamic = await taskInputs(root, git("rev-parse", "HEAD"), tasks, workspaces)
    expect(dynamic.pressure!.complete).toBe(false)
    expect(plan(["packages/core/src/unrelated.ts"], dynamic).selected).toContain("pressure")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function selectionFixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-input-counterexample-"))
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "CI Fixture",
        GIT_AUTHOR_EMAIL: "ci@fixture.test",
        GIT_COMMITTER_NAME: "CI Fixture",
        GIT_COMMITTER_EMAIL: "ci@fixture.test",
      },
    }).trim()
  try {
    const directories = ["packages/core", "packages/bridge", "packages/data"]
    for (const [file, content] of Object.entries({
      "package.json": JSON.stringify({ workspaces: { packages: directories } }),
      ...Object.fromEntries(
        directories.map((directory) => [
          `${directory}/package.json`,
          JSON.stringify({ name: directory.split("/")[1] }),
        ]),
      ),
      ...files,
    }))
      await Bun.write(path.join(root, file), content)
    git("init", "--quiet")
    git("add", ".")
    git("commit", "--quiet", "-m", "selection counterexample")
    const revision = git("rev-parse", "HEAD")
    const workspaces = await workspaceInputs(root, revision)
    const tasks: Task[] = [
      { id: "policy", kind: "policy", pool: "linux", owners: [], needs: [], seconds: 1 },
      {
        id: "pressure",
        kind: "rollout",
        pool: "linux",
        owners: ["packages/core"],
        needs: [],
        seconds: 1,
        inputs: ["packages/core/test/pressure.test.ts"],
      },
    ]
    const inputs = await taskInputs(root, revision, tasks, workspaces)
    return {
      workspaces,
      inputs,
      plan(changed: string[]) {
        return createPlan({
          base: revision,
          head: revision,
          sha: revision,
          run: "fixture",
          mode: "affected",
          changed,
          tasks,
          baseWorkspaces: workspaces,
          headWorkspaces: workspaces,
          baseInputs: inputs,
          headInputs: inputs,
        })
      },
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

test("integration inputs retain another workspace's test resource dependencies", async () => {
  await using fixture = await selectionFixture({
    "packages/core/test/pressure.test.ts": 'import "bridge/test/helper"',
    "packages/bridge/test/helper.ts": 'export const fixture = new URL("../../data/src/value.ts", import.meta.url)',
    "packages/data/src/value.ts": "export const value = 1",
  })
  expect(fixture.workspaces.find((entry) => entry.name === "bridge")!.testDependencies).toContain("data")
  expect(fixture.plan(["packages/data/src/value.ts"]).selected).toContain("pressure")
})

test.each([
  { alias: "runtime/*", target: "src/*", input: "runtime/value", file: "packages/core/src/value.ts" },
  { alias: "@/*", target: "runtime/*", input: "@/value", file: "packages/core/runtime/value.ts" },
])("unsupported aliases cannot silently exclude their real inputs: $alias", async ({ alias, target, input, file }) => {
  await using fixture = await selectionFixture({
    "packages/core/tsconfig.json": JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { [alias]: [target] } } }),
    "packages/core/test/pressure.test.ts": `import { value } from ${JSON.stringify(input)}; export { value }`,
    "packages/core/src/value.ts": "export const value = 1",
    [file]: "export const value = 2",
  })
  expect(fixture.plan([file]).selected).toContain("pressure")
})

test("unresolved dynamic inputs cannot skip a change in an unclassified workspace", async () => {
  await using fixture = await selectionFixture({
    "packages/core/test/pressure.test.ts": "await import(process.env.FIXTURE_MODULE!)",
    "packages/data/src/value.ts": "export const value = 1",
  })
  expect(fixture.inputs.pressure!.complete).toBe(false)
  expect(fixture.plan(["packages/data/src/value.ts"]).selected).toContain("pressure")
})

test("unresolved inputs inside a cross-workspace dependency remain conservative", async () => {
  await using fixture = await selectionFixture({
    "packages/core/test/pressure.test.ts": 'import "bridge/test/helper"',
    "packages/bridge/test/helper.ts": "await import(process.env.FIXTURE_MODULE!)",
    "packages/data/src/value.ts": "export const value = 1",
  })
  expect(fixture.inputs.pressure!.complete).toBe(false)
  expect(fixture.plan(["packages/data/src/value.ts"]).selected).toContain("pressure")
})

test("public workspace imports inspect their entrypoint without unrelated scripts", async () => {
  await using fixture = await selectionFixture({
    "packages/core/test/pressure.test.ts": 'import "bridge/helper"',
    "packages/bridge/package.json": JSON.stringify({
      name: "bridge",
      exports: { "./helper": { bun: "./src/helper.ts", import: "./dist/helper.js" } },
    }),
    "packages/bridge/src/helper.ts": 'export const fixture = new URL("../../data/src/value.ts", import.meta.url)',
    "packages/bridge/script/unrelated.ts": "await import(process.env.DETECTOR!)",
    "packages/data/src/value.ts": "export const value = 1",
  })
  expect(fixture.inputs.pressure!.complete).toBe(true)
  expect(fixture.plan(["packages/data/src/value.ts"]).selected).toContain("pressure")
})

test("unresolved package imports inside another workspace cannot hide inputs", async () => {
  await using fixture = await selectionFixture({
    "packages/core/test/pressure.test.ts": 'import "bridge/test/helper"',
    "packages/bridge/test/helper.ts": 'import "#fixture"',
    "packages/data/src/value.ts": "export const value = 1",
  })
  expect(fixture.inputs.pressure!.complete).toBe(false)
  expect(fixture.plan(["packages/data/src/value.ts"]).selected).toContain("pressure")
})

test("the execution CLI can start on Docker workers without node_modules", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-cli-no-dependencies-"))
  const repository = path.resolve(import.meta.dir, "../..")
  try {
    for (const directory of ["script", "packages/testing/src", "packages/testing/script"])
      await cp(path.join(repository, directory), path.join(root, directory), {
        recursive: true,
        filter: (file) => !["node_modules", ".artifacts", ".turbo", "coverage"].includes(path.basename(file)),
      })
    const backendFixture = "packages/harness/test/support/storage-backends.ts"
    await Bun.write(path.join(root, backendFixture), Bun.file(path.join(repository, backendFixture)))
    const child = Bun.spawn([process.execPath, "--no-install", "script/ci.ts", "--help"], {
      cwd: root,
      env: { ...process.env, HOME: root, XDG_CONFIG_HOME: path.join(root, "config") },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect(stdout).toContain("Usage: bun script/ci.ts")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
