import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import type { BlobStore } from "@ericsanchezok/synergy-harness/storage/blobs"
import { NativeWorkspacePortableTree as Portable } from "../../src/workspace/portable-tree"

async function git(directory: string, args: string[], input?: string) {
  const process = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd: directory,
    env: {
      ...globalThis.process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ])
  if (code) throw new Error(`Fixture Git ${args[0]} failed: ${stderr}`)
  return stdout
}

test("paged Workspace capture substitutes independent Git metadata and restores after both original directories disappear", async () => {
  await using runtime = await testRuntime()
  await using temporary = await tmpdir()
  await runtime.run(async () => {
    const main = path.join(temporary.path, "main")
    const source = path.join(temporary.path, "linked")
    await fs.mkdir(main)
    await git(main, ["init", "--template="])
    await git(main, ["config", "user.name", "Source fixture"])
    await git(main, ["config", "user.email", "source@example.invalid"])
    await git(main, ["config", "remote.origin.url", "https://private-token@example.invalid/project"])
    await Bun.write(path.join(main, "tracked"), "base\n")
    await Bun.write(path.join(main, ".gitignore"), ".ignored\n")
    await git(main, ["add", "."])
    await git(main, ["commit", "-m", "Base"])
    await git(main, ["tag", "original"])
    const dangling = (await git(main, ["hash-object", "-w", "--stdin"], "retained dangling bytes")).trim()
    await git(main, ["worktree", "add", "-b", "selected", source])
    await Bun.write(path.join(source, "tracked"), "staged\n")
    await git(source, ["add", "tracked"])
    await Bun.write(path.join(source, "tracked"), "unstaged\n")
    await Bun.write(path.join(source, "untracked"), "untracked bytes")
    await Bun.write(path.join(source, ".ignored"), "ignored bytes")
    const expected = {
      head: await git(source, ["rev-parse", "HEAD"]),
      refs: await git(source, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      status: await git(source, ["status", "--porcelain=v1", "-z"]),
      staged: await git(source, ["diff", "--cached", "--no-ext-diff", "--no-textconv"]),
    }
    const objects = new Map<string, Uint8Array>()
    const store: BlobStore = {
      async put(hash, bytes) {
        objects.set(hash, bytes.slice())
      },
      async get(hash, maximum) {
        const bytes = objects.get(hash)
        if (!bytes || bytes.byteLength > maximum) throw new Error("Missing bounded object")
        return bytes.slice()
      },
    }
    const captured = await Portable.capture({ root: source, directory: path.join(temporary.path, "cache"), store })
    await fs.rm(source, { recursive: true })
    await fs.rm(main, { recursive: true })
    const target = path.join(temporary.path, "target")
    await Portable.materialize({ root: target, directory: path.join(temporary.path, "read"), captured, store })
    expect((await fs.lstat(path.join(target, ".git"))).isDirectory()).toBe(true)
    expect(await git(target, ["rev-parse", "HEAD"])).toBe(expected.head)
    expect(await git(target, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(expected.refs)
    expect(await git(target, ["status", "--porcelain=v1", "-z"])).toBe(expected.status)
    expect(await git(target, ["diff", "--cached", "--no-ext-diff", "--no-textconv"])).toBe(expected.staged)
    expect(await git(target, ["cat-file", "blob", dangling])).toBe("retained dangling bytes")
    expect(await Bun.file(path.join(target, ".ignored")).text()).toBe("ignored bytes")
    expect(await Bun.file(path.join(target, "untracked")).text()).toBe("untracked bytes")
    expect(await Bun.file(path.join(target, ".git", "config")).text()).not.toContain("private-token")
    await git(target, [
      "-c",
      "user.name=Target fixture",
      "-c",
      "user.email=target@example.invalid",
      "commit",
      "-m",
      "Independent",
    ])
    expect(await git(target, ["rev-parse", "HEAD"])).not.toBe(expected.head)
  })
})

test("paged Git export rechecks original metadata after content writes and still rejects working-file credentials", async () => {
  await using runtime = await testRuntime()
  await using temporary = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(temporary.path, "source")
    await fs.mkdir(source)
    await git(source, ["init", "--template="])
    await Bun.write(path.join(source, "file"), "original working bytes")
    let changed = false
    const store: BlobStore = {
      async put() {
        if (changed) return
        changed = true
        await git(source, ["symbolic-ref", "HEAD", "refs/heads/changed"])
      },
      async get() {
        throw new Error("unused")
      },
    }
    await expect(
      Portable.capture({ root: source, directory: path.join(temporary.path, "changed"), store }),
    ).rejects.toThrow("changed")
    expect(changed).toBe(true)
    await Bun.write(path.join(source, ".env"), "PRIVATE_FIXTURE_VALUE=never-export")
    let exported = 0
    await expect(
      Portable.capture({
        root: source,
        directory: path.join(temporary.path, "credential"),
        store: {
          ...store,
          async put() {
            exported++
          },
        },
      }),
    ).rejects.toThrow("credential")
    expect(exported).toBe(0)
  })
})
