import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlan, type Task } from "../../script/ci/plan"
import { executeUnit } from "../../script/ci/run"
import { distributionPaths, publishDistribution } from "../../script/ci/distributions"
import { createIsolatedTestEnv } from "../../packages/testing/src/env"

test("a profile-only Web plan prepares the sandbox assets required by its distribution", async () => {
  const isolated = await createIsolatedTestEnv()
  try {
    const root = path.resolve(import.meta.dir, "../..")
    const output = path.join(isolated.env.SYNERGY_TEST_ROOT!, "github-output")
    const plan = path.join(isolated.env.SYNERGY_TEST_ROOT!, "plan.json")
    const child = Bun.spawn(
      [
        process.execPath,
        "script/ci.ts",
        "plan",
        "--base",
        "HEAD",
        "--head",
        "HEAD",
        "--sha",
        "HEAD",
        "--mode",
        "diagnostic",
        "--only",
        "web-integration",
        "--output",
        plan,
      ],
      {
        cwd: root,
        env: { ...isolated.env, GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: undefined },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" })
    expect((await Bun.file(plan).json()).selected).toEqual(["web-integration"])
    const lines = (await Bun.file(output).text()).split("\n")
    expect(lines).toContain("full=true")
    expect(lines).toContain("sandbox=1")
  } finally {
    await isolated.dispose()
  }
}, 30000)

test.each([undefined, "full"] as const)(
  "Linux %s tasks overlap in separate Homes and publish separate results",
  async (profile) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "ci-linux-overlap-"))
    try {
      const tasks: Task[] = Array.from({ length: 9 }, (_, index) => ({
        id: `plain-${index}`,
        kind: "smoke",
        seconds: 1,
        pool: "linux",
        owners: [],
        needs: [],
        outputs: [],
        profile,
      }))
      const plan = createPlan({
        base: "a",
        head: "b",
        sha: "c",
        run: "fixture",
        mode: "full",
        changed: [],
        tasks,
        baseWorkspaces: [],
        headWorkspaces: [],
      })
      await Bun.write(
        path.join(root, "script/ci/smoke.ts"),
        `
      await Bun.write(${JSON.stringify(path.join(root, "ready-"))}+process.pid,process.env.SYNERGY_TEST_HOME!);
      const until=Date.now()+1500;
      while(Array.from(new Bun.Glob("ready-*").scanSync({cwd:${JSON.stringify(root)}})).length<2 && Date.now()<until) await Bun.sleep(10);
      if(Array.from(new Bun.Glob("ready-*").scanSync({cwd:${JSON.stringify(root)}})).length!==2) throw new Error("Tasks did not overlap");
    `,
      )
      const unit = plan.units.find((unit) => unit.tasks.length === 2)!
      let preparations = 0
      expect(
        await executeUnit(
          plan,
          unit.id,
          root,
          async (actual) => {
            expect(actual).toBe("full")
            preparations++
            for (const prefix of distributionPaths("full")) await Bun.write(path.join(root, prefix, "fixture"), "built")
            await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
            await publishDistribution(root, plan, "full")
          },
          "2",
        ),
      ).toEqual([])
      expect(preparations).toBe(profile ? 1 : 0)
      const homes = await Promise.all(
        Array.from(new Bun.Glob("ready-*").scanSync({ cwd: root })).map((file) =>
          Bun.file(path.join(root, file)).text(),
        ),
      )
      expect(new Set(homes).size).toBe(2)
      for (const id of unit.tasks) {
        const result = await Bun.file(path.join(root, ".artifacts/ci/results", id, "result.json")).json()
        expect(result.status).toBe("success")
        expect(result.planAttempt).toBe(plan.attempt)
        expect(result.executionAttempt).toBe("2")
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  },
  10000,
)

test("Docker tasks overlap only isolated processes and retain every task result", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-docker-groups-"))
  try {
    const tasks: Task[] = Array.from({ length: 8 }, (_, index) => ({
      id: `isolated-${index}`,
      kind: "static",
      variant: "tests",
      seconds: 1,
      pool: "docker",
      owners: [],
      needs: [],
      files: [`test/isolated-${index}.test.ts`],
      outputs: [],
    }))
    const plan = createPlan({
      base: "a",
      head: "b",
      sha: "c",
      run: "fixture",
      mode: "full",
      changed: [],
      tasks,
      only: tasks.map((task) => task.id),
      baseWorkspaces: [],
      headWorkspaces: [],
    })
    for (const task of tasks)
      await Bun.write(
        path.join(root, task.files![0]!),
        `import {test,expect} from "bun:test"; test("isolated overlap",async()=>{
        await Bun.write(${JSON.stringify(path.join(root, `ready-${task.id}`))},process.env.SYNERGY_TEST_HOME!);
        const until=Date.now()+2000;
        while(Array.from(new Bun.Glob("ready-*").scanSync({cwd:${JSON.stringify(root)}})).length<2 && Date.now()<until) await Bun.sleep(10);
        expect(Array.from(new Bun.Glob("ready-*").scanSync({cwd:${JSON.stringify(root)}})).length).toBeGreaterThanOrEqual(2);
      })`,
      )
    const unit = plan.units[0]!
    expect(unit.tasks).toHaveLength(4)
    expect(await executeUnit(plan, unit.id, root)).toEqual([])
    const homes = await Promise.all(unit.tasks.map((id) => Bun.file(path.join(root, `ready-${id}`)).text()))
    expect(new Set(homes).size).toBe(4)
    for (const id of unit.tasks)
      expect((await Bun.file(path.join(root, ".artifacts/ci/results", id, "result.json")).json()).status).toBe(
        "success",
      )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 10000)

test("ordinary tests execute before waiting for a profile, which is restored once for all its consumers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ci-preparation-"))
  try {
    const tasks: Task[] = [
      ...[0, 1].map(
        (index): Task => ({
          id: `plain-${index}`,
          kind: "static",
          variant: "tests",
          seconds: 1,
          pool: "linux",
          owners: [],
          needs: [],
          files: [`test/plain-${index}.test.ts`],
          outputs: [],
        }),
      ),
      ...[0, 1, 2, 3].map(
        (index): Task => ({
          id: `profile-${index}`,
          kind: "static",
          variant: "tests",
          profile: "full",
          seconds: 10,
          pool: "linux",
          owners: [],
          needs: [],
          files: [`test/profile-${index}.test.ts`],
          outputs: [],
        }),
      ),
    ]
    const plan = createPlan({
      base: "a",
      head: "b",
      sha: "c",
      run: "fixture",
      mode: "diagnostic",
      changed: [],
      tasks,
      only: tasks.map((task) => task.id),
      baseWorkspaces: [],
      headWorkspaces: [],
    })
    for (const task of tasks)
      await Bun.write(
        path.join(root, task.files![0]!),
        task.profile
          ? `import {expect,test} from "bun:test"; test("prepared input",async()=>expect(await Bun.file(${JSON.stringify(path.join(root, "apps/web/dist/fixture"))}).text()).toBe("built"))`
          : `import {test} from "bun:test"; test("ordinary input",()=>Bun.write(${JSON.stringify(path.join(root, task.id))},"ran"))`,
      )
    const unit = plan.units.find((unit) => unit.tasks.some((id) => id.startsWith("plain-")))!
    let preparations = 0
    expect(
      await executeUnit(plan, unit.id, root, async (profile) => {
        expect(profile).toBe("full")
        preparations++
        for (const id of unit.tasks.filter((id) => id.startsWith("plain-")))
          expect(await Bun.file(path.join(root, id)).text()).toBe("ran")
        for (const prefix of distributionPaths("full")) await Bun.write(path.join(root, prefix, "fixture"), "built")
        await Bun.write(path.join(root, ".artifacts/ci/build/manifest.json"), "base fixture")
        await publishDistribution(root, plan, "full")
      }),
    ).toEqual([])
    expect(preparations).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
