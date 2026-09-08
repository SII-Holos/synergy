import * as fs from "fs/promises"
import path from "path"
type TmpDirOptions<T, TConfig> = {
  git?: boolean
  config?: Partial<TConfig>
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
export interface FixtureBinding<TConfig, TScope> {
  sanitizePath(value: string): string
  writeConfig(directory: string, config: Partial<TConfig>): Promise<void>
  scope(directory: string): Promise<TScope>
}

export function createFixture<TConfig, TScope>(binding: FixtureBinding<TConfig, TScope>) {
  return async function tmpdir<T>(options?: TmpDirOptions<T, TConfig>) {
    const root = process.env["SYNERGY_TEST_ROOT"]
    if (!root) {
      throw new Error(
        "tmpdir() requires SYNERGY_TEST_ROOT to be set. The test preload (test/preload.ts) is not active — " +
          "running bun test with --isolate (or without the bunfig [test] preload) bypasses isolation and would " +
          "write fixtures into the real home directory.",
      )
    }
    const dirpath = binding.sanitizePath(path.join(root, "synergy-fixture-" + Math.random().toString(36).slice(2)))
    await fs.mkdir(dirpath, { recursive: true })
    if (options?.git) await initializeGitFixture(dirpath)
    if (options?.config) {
      await binding.writeConfig(dirpath, options.config)
    }
    const extra = await options?.init?.(dirpath)
    await fs.mkdir(path.join(dirpath, ".synergy"), { recursive: true }).catch(() => {})
    const realpath = binding.sanitizePath(await fs.realpath(dirpath))
    const result = {
      [Symbol.asyncDispose]: async () => {
        await options?.dispose?.(dirpath)
        // Scope-owned asynchronous work may outlive this lexical fixture. The
        // process cleanup root created by preload.ts reclaims all fixtures after
        // those references have settled without deleting paths mid-test.
      },
      path: realpath,
      extra: extra as T,
      async scope(): Promise<TScope> {
        return binding.scope(realpath)
      },
    }
    return result
  }
}
