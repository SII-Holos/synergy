import { expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { testRuntime } from "@ericsanchezok/synergy-harness/test/support/runtime"
import { NativePortableGit as Portable } from "../../src/workspace/portable-git"
import { SnapshotStore } from "@ericsanchezok/synergy-harness/session/snapshot-store"

async function git(directory: string, args: string[], input?: string, home?: string) {
  const proc = Bun.spawn(["git", "-c", "core.fsmonitor=false", ...args], {
    cwd: directory,
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: home ? path.join(home, ".gitconfig") : "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
    },
    stdin: input === undefined ? "ignore" : new Blob([input]),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  if (code) throw new Error(`Fixture Git ${args[0]} failed: ${stderr}`)
  return stdout
}
async function repository(directory: string) {
  await fs.mkdir(directory, { recursive: true })
  await git(directory, ["init", "--template="])
  await git(directory, ["config", "user.name", "Portable fixture"])
  await git(directory, ["config", "user.email", "portable@example.invalid"])
  await Bun.write(path.join(directory, "tracked"), "base\n")
  await Bun.write(path.join(directory, ".gitignore"), ".ignored\n")
  await git(directory, ["add", "."])
  await git(directory, ["commit", "-m", "Base"])
}
async function restored(source: string, prepared: Portable.Prepared, target: string) {
  await fs.mkdir(target)
  const children = await fs.opendir(source)
  for await (const child of children) {
    if (child.name !== ".git")
      await fs.cp(path.join(source, child.name), path.join(target, child.name), { recursive: true })
  }
  await fs.cp(prepared.gitDirectory, path.join(target, ".git"), { recursive: true })
}

test("linked Git Workspaces retain full objects, refs, HEAD and staged changes independently of the removed source", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const main = path.join(tmp.path, "main")
    const linked = path.join(tmp.path, "linked")
    await repository(main)
    await git(main, ["branch", "side"])
    await git(main, ["tag", "-a", "v1", "-m", "Tagged base"])
    await git(main, ["config", "remote.origin.url", "https://fake-private-token@example.invalid/project"])
    const dangling = (await git(main, ["hash-object", "-w", "--stdin"], "unreachable original object")).trim()
    await git(main, ["config", "core.filemode", "false"])
    await git(main, ["update-ref", "refs/remotes/origin/main", "HEAD"])
    await git(main, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"])
    await git(main, ["update-ref", "refs/worktree/selected", dangling])
    await git(main, ["pack-refs", "--all"])
    await git(main, ["worktree", "add", "-b", "feature", linked])
    await git(linked, ["update-ref", "refs/worktree/selected", "HEAD"])
    await Bun.write(path.join(linked, "tracked"), "staged\n")
    await git(linked, ["add", "tracked"])
    await Bun.write(path.join(linked, "tracked"), "unstaged\n")
    await Bun.write(path.join(linked, "untracked"), "untracked bytes")
    await Bun.write(path.join(linked, ".ignored"), "ignored bytes")
    const expected = {
      head: await git(linked, ["rev-parse", "HEAD"]),
      refs: await git(linked, ["for-each-ref", "--format=%(refname) %(objectname)"]),
      status: await git(linked, ["status", "--porcelain=v1", "-z"]),
      staged: await git(linked, ["diff", "--cached", "--no-ext-diff", "--no-textconv"]),
    }
    const source = await Portable.discover({ directory: linked })
    expect(source?.root).toBe(await fs.realpath(linked))
    if (!source) throw new Error("Fixture must be a Git Workspace")
    expect(source.commonDirectory).toBe(await fs.realpath(path.join(main, ".git")))
    const originalIndex = await fs.readFile(path.join(source.gitDirectory, "index"))
    const originalConfig = await fs.readFile(path.join(source.commonDirectory, "config"))
    await using prepared = await Portable.prepare({ source, directory: path.join(tmp.path, "prepared") })
    const target = path.join(tmp.path, "target")
    await restored(linked, prepared, target)
    await prepared.verify()
    expect(await fs.readFile(path.join(source.gitDirectory, "index"))).toEqual(originalIndex)
    expect(await fs.readFile(path.join(source.commonDirectory, "config"))).toEqual(originalConfig)
    await fs.rm(linked, { recursive: true })
    await fs.rm(main, { recursive: true })
    expect(await git(target, ["rev-parse", "HEAD"])).toBe(expected.head)
    expect(await git(target, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(expected.refs)
    expect(await git(target, ["status", "--porcelain=v1", "-z"])).toBe(expected.status)
    expect(await git(target, ["diff", "--cached", "--no-ext-diff", "--no-textconv"])).toBe(expected.staged)
    expect(await git(target, ["cat-file", "blob", dangling])).toBe("unreachable original object")
    expect((await git(target, ["config", "core.filemode"])).trim()).toBe("false")
    expect((await git(target, ["symbolic-ref", "refs/remotes/origin/HEAD"])).trim()).toBe("refs/remotes/origin/main")
    expect(await Bun.file(path.join(target, ".ignored")).text()).toBe("ignored bytes")
    expect(await Bun.file(path.join(target, "untracked")).text()).toBe("untracked bytes")
    expect(await Bun.file(path.join(target, ".git", "config")).text()).not.toContain("fake-private-token")
    await git(target, ["config", "user.name", "Independent target"])
    await git(target, ["config", "user.email", "target@example.invalid"])
    await git(target, ["commit", "-m", "Independent staged commit"])
    expect(await git(target, ["rev-parse", "HEAD^"])).toBe(expected.head)
    expect(await git(target, ["status", "--porcelain=v1"])).toContain(" M tracked")
  })
}, 15_000)

test.each(["git_submodule", "git_lfs", "git_alternates", "git_in_progress"] as const)(
  "unsupported %s dependencies block Git capture explicitly",
  async (kind) => {
    await using runtime = await testRuntime()
    await using tmp = await tmpdir()
    await runtime.run(async () => {
      const source = path.join(tmp.path, "source")
      await repository(source)
      if (kind === "git_submodule")
        await Bun.write(path.join(source, ".gitmodules"), '[submodule "fixture"]\npath = dependency\n')
      if (kind === "git_lfs")
        await Bun.write(path.join(source, ".gitattributes"), "* filter=lfs diff=lfs merge=lfs -text\n")
      if (kind === "git_alternates")
        await Bun.write(
          path.join(source, ".git", "objects", "info", "alternates"),
          path.join(tmp.path, "unavailable-objects") + "\n",
        )
      if (kind === "git_in_progress")
        await Bun.write(path.join(source, ".git", "MERGE_HEAD"), await git(source, ["rev-parse", "HEAD"]))
      await expect(
        (async () => {
          const discovered = await Portable.discover({ directory: source })
          if (!discovered) throw new Error("Fixture repository is unavailable")
          await using prepared = await Portable.prepare({
            source: discovered,
            directory: path.join(tmp.path, "prepared"),
          })
        })(),
      ).rejects.toMatchObject({ data: { missing: { kind } } })
    })
  },
)

test("Git capture fixes its native metadata and rejects external refs or index changes before handoff", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await repository(source)
    const discovered = await Portable.discover({ directory: source })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    await git(source, ["update-ref", "refs/heads/late", "HEAD"])
    await expect(
      Portable.prepare({ source: discovered, directory: path.join(tmp.path, "stale") }),
    ).rejects.toMatchObject({ name: "NativePortableGitChanged" })
    const current = await Portable.discover({ directory: source })
    if (!current) throw new Error("Fixture repository is unavailable")
    await using prepared = await Portable.prepare({ source: current, directory: path.join(tmp.path, "prepared") })
    await Bun.write(path.join(source, "tracked"), "external staged bytes\n")
    await git(source, ["add", "tracked"])
    await expect(prepared.verify()).rejects.toMatchObject({ name: "NativePortableGitChanged" })
  })
})

test.each(["detached", "unborn"] as const)(
  "standalone %s HEAD and index remain independent of the source",
  async (kind) => {
    await using runtime = await testRuntime()
    await using tmp = await tmpdir()
    await runtime.run(async () => {
      const source = path.join(tmp.path, "source")
      if (kind === "detached") {
        await repository(source)
        await git(source, ["checkout", "--detach"])
      } else {
        await fs.mkdir(source)
        await git(source, ["init", "--template="])
        await Bun.write(path.join(source, "tracked"), "first staged content\n")
      }
      await git(source, ["add", "tracked"])
      const head = await fs.readFile(path.join(source, ".git", "HEAD"))
      const index = await fs.readFile(path.join(source, ".git", "index"))
      const discovered = await Portable.discover({ directory: source })
      if (!discovered) throw new Error("Fixture repository is unavailable")
      await using prepared = await Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") })
      const target = path.join(tmp.path, "target")
      await restored(source, prepared, target)
      await prepared.verify()
      await fs.rm(source, { recursive: true })
      expect(await fs.readFile(path.join(target, ".git", "HEAD"))).toEqual(head)
      expect(await fs.readFile(path.join(target, ".git", "index"))).toEqual(index)
      await git(target, ["status", "--porcelain=v1"])
      await git(target, ["config", "user.name", "Explicit target"])
      await git(target, ["config", "user.email", "target@example.invalid"])
      await git(target, ["commit", "--allow-empty", "-m", "Independent target"])
    })
  },
)

test("Git verification remains owned until disposal drains its active callback", async () => {
  await using runtime = await testRuntime()
  await using other = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await repository(source)
    const discovered = await Portable.discover({ directory: source })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    using crossVolume = spyOn(fs, "link").mockImplementation(async () => {
      throw Object.assign(new Error("A native cross-volume link is unavailable"), { code: "EXDEV" })
    })
    await using prepared = await Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") })
    await other.run(async () => {
      await expect(prepared.verify()).rejects.toMatchObject({ data: { missing: { kind: "git_binding" } } })
    })
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const initialize = SnapshotStore.initializeBareRepository
    using held = spyOn(SnapshotStore, "initializeBareRepository").mockImplementation(async (...args) => {
      await initialize(...args)
      entered.resolve()
      await release.promise
    })
    const verification = prepared.verify().catch((error) => error)
    await entered.promise
    await expect(prepared.verify()).rejects.toMatchObject({ name: "NativePortableGitBusy" })
    let closed = false
    const closing = prepared[Symbol.asyncDispose]().then(() => {
      closed = true
    })
    await Promise.resolve()
    expect(closed).toBe(false)
    release.resolve()
    await closing
    expect(await verification).toMatchObject({ data: { missing: { kind: "git_binding" } } })
    await expect(prepared.verify()).rejects.toMatchObject({ data: { missing: { kind: "git_binding" } } })
  })
})

test("Git capture and restored commits cannot execute the Host's configured hooks or carry source credentials", async () => {
  await using tmp = await tmpdir()
  const home = path.join(tmp.path, "git-home")
  await fs.mkdir(home)
  await using runtime = await testRuntime({ env: { HOME: home, XDG_CONFIG_HOME: path.join(home, ".config") } })
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await repository(source)
    const hooks = path.join(tmp.path, "malicious-hooks")
    const marker = path.join(tmp.path, "hook-executed")
    await fs.mkdir(hooks)
    const hook = path.join(hooks, "reference-transaction")
    const quoted = "'" + marker.replaceAll("'", "'\"'\"'") + "'"
    await Bun.write(hook, "#!/bin/sh\nprintf active >> " + quoted + "\n")
    await fs.chmod(hook, 0o755)
    await git(source, ["config", "--file", path.join(home, ".gitconfig"), "core.hooksPath", hooks])
    await git(source, ["config", "--file", path.join(home, ".gitconfig"), "commit.gpgSign", "false"])
    await git(source, ["update-ref", "refs/heads/control", "HEAD"], undefined, home)
    expect(await Bun.file(marker).exists()).toBe(true)
    await fs.rm(marker)
    await git(source, ["config", "remote.origin.url", "https://fake-portable-credential@example.invalid/repository"])
    await git(source, ["config", "credential.helper", "!false"])
    await Bun.write(path.join(source, "tracked"), "safe staged change\n")
    await git(source, ["add", "tracked"], undefined, home)
    const discovered = await Portable.discover({ directory: source })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    await using prepared = await Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") })
    const target = path.join(tmp.path, "target")
    await restored(source, prepared, target)
    await prepared.verify()
    await git(target, ["config", "user.name", "Explicit target identity"], undefined, home)
    await git(target, ["config", "user.email", "target@example.invalid"], undefined, home)
    await git(target, ["commit", "-m", "Safe independent commit"], undefined, home)
    expect(await Bun.file(marker).exists()).toBe(false)
    const config = await Bun.file(path.join(target, ".git", "config")).text()
    expect(config).not.toContain("fake-portable-credential")
    expect(config).not.toContain("credential.helper")
    expect(config).not.toContain(hooks)
    expect(await Bun.file(path.join(target, ".git", "commondir")).exists()).toBe(false)
  })
}, 15_000)

test("a selected Git subdirectory is not silently promoted to its parent repository", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await repository(source)
    await fs.mkdir(path.join(source, "nested"))
    const discovered = await Portable.discover({ directory: path.join(source, "nested") })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    expect(discovered.root).toBe(await fs.realpath(source))
    await expect(
      Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") }),
    ).rejects.toMatchObject({ data: { missing: { kind: "git_root" } } })
  })
})

test("a relocated common Git directory cannot retarget a discovered native dependency through an alias", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const main = path.join(tmp.path, "main")
    const linked = path.join(tmp.path, "linked")
    await repository(main)
    await git(main, ["worktree", "add", "-b", "feature", linked])
    const discovered = await Portable.discover({ directory: linked })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    const moved = path.join(tmp.path, "moved-common.git")
    await fs.rename(path.join(main, ".git"), moved)
    await fs.symlink(moved, path.join(main, ".git"), process.platform === "win32" ? "junction" : "dir")
    await expect(
      Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") }),
    ).rejects.toMatchObject({ name: "NativePortableGitChanged" })
  })
})

test("a failed private Git cleanup can retry without reopening verification", async () => {
  await using runtime = await testRuntime()
  await using tmp = await tmpdir()
  await runtime.run(async () => {
    const source = path.join(tmp.path, "source")
    await repository(source)
    const discovered = await Portable.discover({ directory: source })
    if (!discovered) throw new Error("Fixture repository is unavailable")
    const prepared = await Portable.prepare({ source: discovered, directory: path.join(tmp.path, "prepared") })
    const directory = path.dirname(prepared.gitDirectory)
    const remove = fs.rm
    const failed = new Error("The private cache is temporarily held")
    let fault = true
    using cleanup = spyOn(fs, "rm").mockImplementation(async (filename, options) => {
      if (fault && filename === directory) {
        fault = false
        throw failed
      }
      return remove(filename, options)
    })
    try {
      await expect(prepared[Symbol.asyncDispose]()).rejects.toBe(failed)
      await expect(prepared.verify()).rejects.toMatchObject({ data: { missing: { kind: "git_binding" } } })
      await prepared[Symbol.asyncDispose]()
      expect(
        await fs.stat(directory).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
    } finally {
      await remove(directory, { recursive: true, force: true })
    }
  })
})

test.each(["refs", "info"] as const)(
  "Git metadata %s cannot redirect reads through an undeclared directory link",
  async (name) => {
    await using runtime = await testRuntime()
    await using tmp = await tmpdir()
    await runtime.run(async () => {
      const source = path.join(tmp.path, "source")
      await repository(source)
      const directory = path.join(source, ".git", name)
      if (name === "info") {
        await fs.mkdir(directory)
        await Bun.write(path.join(directory, "exclude"), "private-exclude-pattern\n")
      }
      const outside = path.join(tmp.path, "external-" + name)
      await fs.rename(directory, outside)
      await fs.symlink(outside, directory, process.platform === "win32" ? "junction" : "dir")
      await expect(Portable.discover({ directory: source })).rejects.toMatchObject({
        data: { missing: { kind: "git_metadata_link" } },
      })
    })
  },
)
