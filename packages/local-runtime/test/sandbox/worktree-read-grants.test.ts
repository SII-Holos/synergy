import { expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { ExecutionProtocol } from "@ericsanchezok/synergy-harness/environment/executor"
import { testRuntime } from "../support/runtime"
import { MacBackend } from "../../src/sandbox/macos"

test.skipIf(process.platform !== "darwin")(
  "linked worktree Git reads survive an ancestor deny without exposing its siblings",
  async () => {
    await using runtime = await testRuntime()
    await runtime.run(async () => {
      const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "synergy-git-grants-")))
      try {
        const denied = path.join(root, ".codex")
        const checkout = path.join(denied, "project")
        const workspace = path.join(checkout, ".synergy", "worktrees", "linked")
        const sibling = path.join(checkout, ".synergy", "worktrees", "sibling")
        fs.mkdirSync(checkout, { recursive: true })
        const git = (...args: string[]) => {
          const result = Bun.spawnSync(["git", "-C", checkout, ...args], { stdout: "pipe", stderr: "pipe" })
          expect({ code: result.exitCode, error: result.stderr.toString() }).toMatchObject({ code: 0 })
          return result.stdout.toString().trim()
        }
        git("init")
        fs.writeFileSync(path.join(checkout, "tracked.txt"), "tracked")
        git("add", "tracked.txt")
        git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.test",
          "-c",
          "core.hooksPath=/dev/null",
          "commit",
          "-m",
          "fixture",
        )
        git("worktree", "add", "-b", "linked", workspace)
        git("worktree", "add", "-b", "sibling", sibling)
        const secret = path.join(denied, "auth.json")
        fs.writeFileSync(secret, "synthetic credential")
        const common = path.join(checkout, ".git")
        const pointer = fs.readFileSync(path.join(workspace, ".git"), "utf8")
        const run = (
          args: string[],
          extraDenies: string[] = [],
          sandboxMode: "workspace_write" | "read_only" = "workspace_write",
        ) => {
          const input = ExecutionProtocol.SandboxInput.parse({
            command: args[0],
            args: args.slice(1),
            workspace,
            originalCheckout: checkout,
            sandboxMode,
            dataDenyRoots: [denied, ...extraDenies],
          })
          const wrapper = MacBackend.prepare(input)
          try {
            return Bun.spawnSync([wrapper.command, ...wrapper.args], { cwd: workspace, stdout: "pipe", stderr: "pipe" })
          } finally {
            if (wrapper.tempPath) MacBackend.cleanupTemp(wrapper.tempPath)
          }
        }
        const read = run(["git", "--no-optional-locks", "show", "HEAD:tracked.txt"])
        expect({ code: read.exitCode, output: read.stdout.toString(), error: read.stderr.toString() }).toEqual({
          code: 0,
          output: "tracked",
          error: "",
        })
        expect(run(["git", "rev-parse", "--show-toplevel"]).stdout.toString().trim()).toBe(workspace)
        expect(run(["git", "--no-optional-locks", "show", "HEAD:tracked.txt"], [], "read_only").stdout.toString()).toBe(
          "tracked",
        )
        expect(run(["/bin/sh", "-c", "printf blocked > blocked.txt"], [], "read_only").exitCode).not.toBe(0)
        expect(fs.existsSync(path.join(workspace, "blocked.txt"))).toBe(false)
        for (const target of [
          secret,
          path.join(checkout, "tracked.txt"),
          path.join(common, "worktrees", "sibling", "HEAD"),
        ]) {
          expect(run(["cat", target]).exitCode).not.toBe(0)
        }
        expect(
          run(["/bin/sh", "-c", 'printf blocked > "$1"', "probe", path.join(common, "refs", "blocked")]).exitCode,
        ).not.toBe(0)
        expect(fs.existsSync(path.join(common, "refs", "blocked"))).toBe(false)
        expect(run(["cat", path.join(common, "config")], [path.join(common, "config")]).exitCode).not.toBe(0)
        fs.writeFileSync(path.join(workspace, ".git"), fs.readFileSync(path.join(sibling, ".git")))
        expect(run(["git", "rev-parse", "--show-toplevel"]).exitCode).not.toBe(0)
        fs.writeFileSync(path.join(workspace, ".git"), pointer)
        fs.renameSync(path.join(common, "config"), path.join(common, "config.saved"))
        fs.symlinkSync(secret, path.join(common, "config"))
        expect(run(["cat", path.join(common, "config")]).exitCode).not.toBe(0)
        fs.renameSync(path.join(common, "objects"), path.join(common, "objects.saved"))
        fs.symlinkSync(denied, path.join(common, "objects"))
        expect(run(["cat", path.join(common, "objects", "auth.json")]).exitCode).not.toBe(0)
      } finally {
        fs.rmSync(root, { recursive: true, force: true })
      }
    })
  },
)
