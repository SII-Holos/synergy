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
  const result = await run(args, cwd)
  if (result.exitCode === 0) return
  throw new Error(
    `Git fixture ${stage} failed with exit code ${result.exitCode}: ${result.stderr.trim() || "no stderr"}`,
  )
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
  const dirpath = Filesystem.sanitizePath(path.join(os.tmpdir(), "synergy-test-" + Math.random().toString(36).slice(2)))
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
      // Cleanup is intentionally disabled: tests often create sessions, scopes, and
      // other persistent state that references the tmpdir path. Deleting the directory
      // in asyncDispose breaks any remaining test assertions that read from it.
      // Instead, preload.ts handles global cleanup via afterAll, and os.tmpdir() is
      // typically purged on reboot. Individual tests manage their own cleanup.
      // await fs.rm(dirpath, { recursive: true, force: true })
    },
    path: realpath,
    extra: extra as T,
    async scope(): Promise<Scope> {
      return (await Scope.fromDirectory(realpath)).scope
    },
  }
  return result
}
