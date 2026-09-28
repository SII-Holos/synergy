import { expect, test } from "bun:test"
import { catalog } from "../../script/ci/catalog"
import { createPlan, executionQueue } from "../../script/ci/plan"
import { commands } from "../../script/ci/run"

test("real Environment lifecycle verification builds its image and cannot silently skip Docker", async () => {
  const tasks = await catalog()
  const task = tasks.find((entry) => entry.id === "execution-environment")
  expect(task).toBeDefined()
  const plan = createPlan({
    base: "base",
    head: "head",
    sha: "tested",
    run: "fixture",
    mode: "full",
    changed: [],
    baseWorkspaces: [],
    headWorkspaces: [],
    tasks,
  })
  const unit = plan.units.find((entry) => entry.tasks.includes(task!.id))!
  expect(executionQueue(unit, tasks)).toBe("docker")
  const recipe = await commands(task!, plan)
  expect(recipe[0]!.args).toContain("install")
  expect(recipe.some((entry) => entry.args.includes("apparmor_parser"))).toBe(true)
  expect(recipe.some((entry) => entry.args.includes("packages/local-runtime/script/build-execution-host.ts"))).toBe(
    true,
  )
  const verification = recipe.at(-1)!
  expect(verification.cwd).toBe("packages/local-runtime")
  expect(verification.env?.SYNERGY_TEST_DOCKER_ENVIRONMENT_IMAGE).toBeTruthy()
  expect(verification.args).toContain("test/environment/remote-docker.test.ts")
})
