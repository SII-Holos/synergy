import * as fs from "fs/promises"
import os from "os"
import path from "path"
import type { Config } from "../../src/config/config"
import { ConfigDomain } from "../../src/config/domain"
import { Scope } from "../../src/scope"
import { Filesystem } from "../../src/util/filesystem"

type TmpDirOptions<T> = {
  git?: boolean
  config?: Partial<Config.Info>
  init?: (dir: string) => Promise<T>
  dispose?: (dir: string) => Promise<T>
}

type GitCommandResult = {
  exitCode: number
  stderr: string
}

export type GitFixtureRunner = (args: string[], cwd: string) => Promise<GitCommandResult>

const GIT_FIXTURE_INIT_MAX_ATTEMPTS = 3
const GIT_FIXTURE_INIT_RETRY_MS = 25

async function runGitCommand(args: string[], cwd: string): Promise<GitCommandResult> {
  try {
    const child = Bun.spawn(["git", ...args], {
      cwd,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    })
    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])
    return { exitCode, stderr }
  } catch (error) {
    return { exitCode: -1, stderr: error instanceof Error ? error.message : String(error) }
  }
}

async function runGitFixtureStage(stage: string, args: string[], cwd: string, run: GitFixtureRunner) {
  const maxAttempts = args[0] === "init" ? GIT_FIXTURE_INIT_MAX_ATTEMPTS : 1
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await run(args, cwd)
    if (result.exitCode === 0) return
    if (result.exitCode === 141 && attempt < maxAttempts) {
      await Bun.sleep(GIT_FIXTURE_INIT_RETRY_MS * attempt)
      continue
    }
    throw new Error(
      `Git fixture ${stage} failed with exit code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
    )
  }
}

export async function initializeGitFixture(dirpath: string, run: GitFixtureRunner = runGitCommand) {
  await runGitFixtureStage("init", ["init"], dirpath, run)
  await fs.appendFile(
    path.join(dirpath, ".git", "config"),
    "\n[user]\n\temail = test@synergy.dev\n\tname = Test Agent\n",
  )
  const commitId = Math.random().toString(36).slice(2)
  await runGitFixtureStage(
    "root commit",
    ["commit", "--allow-empty", "--no-gpg-sign", "-m", `root commit ${commitId}`],
    dirpath,
    run,
  )
}
export async function tmpdir<T>(options?: TmpDirOptions<T>) {
  const root = process.env["SYNERGY_TEST_ROOT"] ?? os.tmpdir()
  const dirpath = Filesystem.sanitizePath(path.join(root, "synergy-test-" + Math.random().toString(36).slice(2)))
  await fs.mkdir(dirpath, { recursive: true })
  if (options?.git) await initializeGitFixture(dirpath)
  if (options?.config) {
    const fragments = ConfigDomain.split({
      $schema: "https://synergy.holosai.io/config.json",
      ...options.config,
    })
    await ConfigDomain.ensureDir(path.join(dirpath, ".synergy"))
    for (const [id, config] of fragments) {
      await Bun.write(ConfigDomain.filepath(id, path.join(dirpath, ".synergy")), JSON.stringify(config, null, 2))
    }
  }
  const extra = await options?.init?.(dirpath)
  await fs.mkdir(path.join(dirpath, ".synergy"), { recursive: true }).catch(() => {})
  const realpath = Filesystem.sanitizePath(await fs.realpath(dirpath))
  const result = {
    [Symbol.asyncDispose]: async () => {
      await options?.dispose?.(dirpath)
      // Scope-owned asynchronous work may outlive this lexical fixture. The
      // process cleanup root created by preload.ts reclaims all fixtures after
      // those references have settled without deleting paths mid-test.
    },
    path: realpath,
    extra: extra as T,
    async scope(): Promise<Scope> {
      return (await Scope.fromDirectory(realpath)).scope
    },
  }
  return result
}
