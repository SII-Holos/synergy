import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { changedFiles, selectValidation, validationEnv } from "../../.github/oryn/validate"

const graph = [
  { path: "packages/harness", name: "harness", dependencies: [] },
  { path: "packages/runtime-local", name: "runtime", dependencies: ["harness"] },
  { path: "apps/web", name: "web", dependencies: ["runtime"] },
  { path: "packages/unrelated", name: "unrelated", dependencies: [] },
]

test("documentation keeps governance checks without selecting unrelated package suites", () => {
  const plan = selectValidation(["docs/operations/oryn.md", "README.md"], graph)
  expect(plan.packages).toEqual([])
  expect(plan.checks).toContainEqual(["bun", "run", "decision:check"])
  expect(plan.tests).toEqual([])
})

test("source changes verify the owner and transitive dependents through package orchestrators", () => {
  const plan = selectValidation(["packages/harness/src/session/example.ts"], graph)
  expect(plan.packages).toEqual(["harness", "runtime", "web"])
  expect(plan.tests).toEqual([
    [
      "bun",
      "turbo",
      "test",
      "--concurrency=2",
      "--env-mode=loose",
      "--filter=harness",
      "--filter=runtime",
      "--filter=web",
    ],
  ])
  expect(selectValidation(["packages/harness/test/fixture.md"], graph).packages).toContain("harness")
})

test("root configuration and unknown executable changes select every trusted workspace", () => {
  for (const file of ["bun.lock", "package.json", "script/check.ts", "new-directory/tool.sh"])
    expect(selectValidation([file], graph).packages).toEqual(["harness", "runtime", "unrelated", "web"])
})

test("validation environment strips model/GitHub credentials and isolates fixture homes", () => {
  const env = validationEnv("/tmp/fixture", {
    PATH: "/bin",
    ORYN_API_KEY: "private",
    GITHUB_TOKEN: "private",
    SYNERGY_HOME: "/real-home",
  })
  expect(env.ORYN_API_KEY).toBeUndefined()
  expect(env.GITHUB_TOKEN).toBeUndefined()
  expect(env.SYNERGY_HOME).toBe("/tmp/fixture")
  expect(env.SYNERGY_TEST_HOME).toBe("/tmp/fixture/test-home")
  expect(env.PLAYWRIGHT_BROWSERS_PATH).toBe("/opt/oryn-browsers")
})

test("changed-file selection includes committed, staged, deleted and untracked repair evidence", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "oryn-validation-"))
  const env = {
    ...validationEnv(directory),
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.com",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.com",
  }
  async function git(...args: string[]) {
    const child = Bun.spawn(["git", ...args], { cwd: directory, env, stdout: "pipe", stderr: "pipe" })
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (code) throw new Error(error)
    return output.trim()
  }
  try {
    await git("init")
    await Bun.write(path.join(directory, "a.txt"), "base\n")
    await Bun.write(path.join(directory, "deleted.txt"), "base\n")
    await git("add", ".")
    await git("commit", "-m", "base")
    const base = await git("rev-parse", "HEAD")
    await Bun.write(path.join(directory, "a.txt"), "committed\n")
    await git("add", ".")
    await git("commit", "-m", "head")
    await mkdir(path.join(directory, "test"))
    await Bun.write(path.join(directory, "test/staged.ts"), "regression\n")
    await git("add", "test/staged.ts")
    await rm(path.join(directory, "deleted.txt"))
    await Bun.write(path.join(directory, "test/new.ts"), "new test\n")
    expect(await changedFiles(directory, base, env)).toEqual(["a.txt", "deleted.txt", "test/new.ts", "test/staged.ts"])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
