import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plan, Task } from "../../script/ci/plan"

async function revisionFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-plan-inputs-"))
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
  const tasks: Task[] = [
    { id: "policy", kind: "policy", pool: "linux", owners: [], needs: [], seconds: 1 },
    ...["complete", "dynamic"].map(
      (id): Task => ({
        id,
        kind: "rollout",
        pool: "linux",
        owners: ["packages/core"],
        needs: [],
        seconds: 1,
        inputs: [`packages/core/test/${id}.test.ts`],
      }),
    ),
  ]
  try {
    for (const [file, content] of Object.entries({
      "package.json": JSON.stringify({ workspaces: { packages: ["packages/core", "packages/bridge"] } }),
      "packages/core/package.json": JSON.stringify({ name: "core" }),
      "packages/bridge/package.json": JSON.stringify({ name: "bridge" }),
      "packages/core/test/complete.test.ts":
        'import "../../bridge/src/old"; new URL("./fixture.json", import.meta.url)',
      "packages/core/test/dynamic.test.ts": "await import(process.env.INPUT!)",
      "packages/core/test/fixture.json": "{}",
      "packages/bridge/src/old.ts": "export const old = 1",
      "packages/bridge/src/new.ts": "export const next = 2",
    }))
      await Bun.write(path.join(root, file), content)
    git("init", "--quiet")
    git("add", ".")
    git("commit", "--quiet", "-m", "base inputs")
    const base = git("rev-parse", "HEAD")
    await Bun.write(path.join(root, "packages/core/test/complete.test.ts"), 'import "../../bridge/src/new"')
    await Bun.write(
      path.join(root, "packages/core/package.json"),
      JSON.stringify({ name: "core", dependencies: { bridge: "*" } }),
    )
    git("add", ".")
    git("commit", "--quiet", "-m", "head inputs")
    const head = git("rev-parse", "HEAD")
    return {
      root,
      base,
      head,
      tasks,
      async [Symbol.asyncDispose]() {
        await rm(root, { recursive: true, force: true })
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

async function observeInputs(fixture: Awaited<ReturnType<typeof revisionFixture>>, equal: boolean, fault = "") {
  const head = equal ? fixture.base : fixture.head
  const child = Bun.spawn(
    [
      process.execPath,
      path.join(import.meta.dir, "ci-plan-inputs-worker.ts"),
      fixture.root,
      fixture.base,
      head,
      JSON.stringify(fixture.tasks),
      "2",
      fault,
    ],
    { cwd: fixture.root, stdout: "pipe", stderr: "pipe" },
  )
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
  return JSON.parse(stdout)
}

function expectedInputs(equal: boolean) {
  const workspaces = (head: boolean) => [
    { directory: "packages/core", name: "core", dependencies: head ? ["bridge"] : [], testDependencies: ["bridge"] },
    { directory: "packages/bridge", name: "bridge", dependencies: [], testDependencies: [] },
  ]
  const inputs = (head: boolean) => ({
    complete: {
      files: [
        `packages/bridge/src/${head ? "new" : "old"}.ts`,
        "packages/core/test/complete.test.ts",
        "packages/core/test/fixture.json",
      ],
      packages: ["packages/bridge"],
      complete: true,
    },
    dynamic: {
      files: ["packages/core/test/dynamic.test.ts", "packages/core/test/fixture.json"],
      packages: [],
      complete: false,
    },
  })
  return {
    changed: equal ? [] : ["packages/core/package.json", "packages/core/test/complete.test.ts"],
    selectionChanges: { leafTests: [] },
    baseWorkspaces: workspaces(false),
    headWorkspaces: workspaces(!equal),
    baseInputs: inputs(false),
    headInputs: inputs(!equal),
  }
}

function expectedPlan(fixture: Awaited<ReturnType<typeof revisionFixture>>, equal: boolean) {
  const head = equal ? fixture.base : fixture.head
  const selected = equal ? ["policy"] : ["complete", "dynamic", "policy"]
  const unit = (id: string, task: string, policy: boolean) => ({
    id,
    pool: "linux" as const,
    tasks: [task],
    seconds: 1,
    browser: false,
    desktop: false,
    sandbox: false,
    build: !policy,
    policy,
    benchmark: false,
    core: false,
    full: false,
  })
  const body: Omit<Plan, "digest"> = {
    version: 1,
    base: fixture.base,
    head,
    sha: head,
    run: "fixture",
    attempt: "1",
    mode: "affected",
    changed: expectedInputs(equal).changed,
    selected,
    proposed: selected,
    reasons: equal
      ? {
          complete: "not affected by this change",
          dynamic: "not affected by this change",
          policy: "affected:  → policy",
        }
      : {
          complete: "full: shared or unclassified input",
          dynamic: "full: shared or unclassified input",
          policy: "full: shared or unclassified input",
        },
    tasks: [fixture.tasks[1]!, fixture.tasks[2]!, fixture.tasks[0]!],
    units: [
      unit("linux-contracts", "policy", true),
      ...(equal ? [] : [unit("linux-0", "complete", false), unit("linux-1", "dynamic", false)]),
    ],
  }
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") }
}

test.each([true, false])(
  "physical revision reads and parses are reused only within one plan: equal=%s",
  async (equal) => {
    await using fixture = await revisionFixture()
    const observed = await observeInputs(fixture, equal)
    const revisions = equal ? 1 : 2
    for (const [index, observation] of observed.observations.entries()) {
      const operations = revisions * (index + 1)
      expect(observation.counts).toEqual({
        inventory: operations,
        batch: operations,
        blobs: 7 * operations,
        parse: 4 * operations,
      })
      expect(observation.inputs).toEqual(expectedInputs(equal))
      expect(JSON.stringify(observation.plan)).toBe(JSON.stringify(expectedPlan(fixture, equal)))
    }
    expect(observed.observations).toHaveLength(2)
    expect(observed.batches).toHaveLength(2 * revisions)
    for (const oids of observed.batches) {
      expect(oids).toHaveLength(7)
      expect(oids.every((oid: string) => /^[a-f0-9]{40}$/.test(oid))).toBe(true)
    }
    const files = [
      "packages/bridge/src/new.ts",
      "packages/bridge/src/old.ts",
      "packages/core/test/complete.test.ts",
      "packages/core/test/dynamic.test.ts",
    ]
    expect(observed.parsedFiles).toEqual(Array.from({ length: 2 * revisions }, () => files).flat())
  },
)

test.each(["truncate", "missing"])("inventory-present corrupt input fails the whole plan: %s", async (fault) => {
  await using fixture = await revisionFixture()
  const observed = await observeInputs(fixture, true, fault)
  expect(observed.observations).toEqual([])
  expect(observed.failure).toMatchObject({ name: "RevisionInputError", revision: fixture.base, stage: "batch" })
  expect(observed.counts).toEqual({ inventory: 1, batch: 1, blobs: 7, parse: 0 })
})
