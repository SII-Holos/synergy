import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlan, type Task } from "../../script/ci/plan"
import { executeUnit } from "../../script/ci/run"
import { distributionPaths, publishDistribution } from "../../script/ci/distributions"

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
        await publishDistribution(root, plan, "full")
      }),
    ).toEqual([])
    expect(preparations).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}, 30000)
