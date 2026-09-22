import { afterAll, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { FileTime } from "@ericsanchezok/synergy-harness/file/time"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { FileMutation } from "../../src/file/mutation"
import { WorkspaceFileService } from "../../src/workspace-file/service"
import { testRuntime } from "../support/runtime"

const runtime = await testRuntime()
afterAll(() => runtime.close())

test("atomic file replacement preserves mode without changing an external hard link", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await using other = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const file = path.join(tmp.path, "script.sh")
        const alias = path.join(other.path, "alias.sh")
        await Bun.write(file, "old\n")
        await fs.chmod(file, 0o751)
        await fs.link(file, alias)
        await WorkspaceFileService.write({
          path: "script.sh",
          content: "new\n",
          expectedVersion: FileTime.version("old\n"),
          encoding: "utf-8",
          createParents: false,
          conflictPolicy: "fail",
        })
        expect(await Bun.file(file).text()).toBe("new\n")
        expect(await Bun.file(alias).text()).toBe("old\n")
        expect((await fs.stat(file)).mode & 0o777).toBe(0o751)
      },
    })
  }))

test("file creation uses a missing-content precondition and preserves base64 bytes", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        const bytes = Uint8Array.from([0, 255, 128, 13, 10, 1])
        const input = {
          path: "nested/ data.bin ",
          content: Buffer.from(bytes).toString("base64"),
          expectedVersion: null,
          encoding: "base64" as const,
          createParents: true,
          conflictPolicy: "fail" as const,
        }
        const result = await WorkspaceFileService.write(input)
        expect(result.existed).toBe(false)
        expect(result.contentVersion).toBe(FileTime.version(bytes))
        expect(await Bun.file(path.join(tmp.path, input.path)).bytes()).toEqual(bytes)
        await expect(WorkspaceFileService.write(input)).rejects.toThrow("changed")
      },
    })
  }))

test("invalid UTF-8 remains binary and malformed base64 cannot create a file", () =>
  runtime.run(async () => {
    await using tmp = await tmpdir()
    await ScopeContext.provide({
      scope: await tmp.scope(),
      fn: async () => {
        await Bun.write(path.join(tmp.path, "invalid.txt"), Uint8Array.from([0x61, 0xff, 0x62]))
        expect((await WorkspaceFileService.read({ path: "invalid.txt", mode: "document" })).kind).toBe("binary")
        await expect(
          WorkspaceFileService.write({
            path: "new.bin",
            content: "AA!",
            encoding: "base64",
            expectedVersion: null,
            createParents: false,
            conflictPolicy: "fail",
          }),
        ).rejects.toThrow("base64")
        expect(await Bun.file(path.join(tmp.path, "new.bin")).exists()).toBe(false)
      },
    })
  }))

test("concurrent native processes cannot both replace the same content version", async () => {
  await using tmp = await tmpdir()
  const target = path.join(tmp.path, "shared.txt")
  await Bun.write(target, "old")
  const implementation = path.resolve(import.meta.dir, "../../src/file/mutation.ts")
  const jobs = ["one", "two"].map((content) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        `
    import { FileMutation } from ${JSON.stringify(implementation)};
    try { await FileMutation.write({ path: ${JSON.stringify(target)}, content: ${JSON.stringify(content)}, expectedVersion: ${JSON.stringify(FileTime.version("old"))} }); console.log("written") }
    catch (error) { console.log(error.name); process.exitCode = error.name === "WorkspaceFileWriteConflictError" ? 0 : 1 }
  `,
      ],
      { stdout: "pipe", stderr: "pipe" },
    ),
  )
  try {
    const results = await Promise.all(
      jobs.map(async (job) => ({ output: await new Response(job.stdout).text(), code: await job.exited })),
    )
    expect(results.every((result) => result.code === 0)).toBe(true)
    expect(results.map((result) => result.output.trim()).sort()).toEqual(["WorkspaceFileWriteConflictError", "written"])
    expect(["one", "two"]).toContain(await Bun.file(target).text())
    expect((await fs.readdir(tmp.path)).filter((name) => name.includes(".synergy-write-"))).toEqual([])
  } finally {
    for (const job of jobs) if (job.exitCode === null) job.kill()
  }
}, 10_000)

test("a changed parent symlink or cancelled write leaves the targets untouched", async () => {
  await using tmp = await tmpdir()
  await using other = await tmpdir()
  const original = path.join(tmp.path, "original")
  const link = path.join(tmp.path, "link")
  await fs.mkdir(original)
  await fs.symlink(original, link, "dir")
  await Bun.write(path.join(original, "a.txt"), "old")
  await Bun.write(path.join(other.path, "a.txt"), "external")
  let validations = 0
  await expect(
    FileMutation.write({
      path: path.join(link, "a.txt"),
      content: "new",
      expectedVersion: FileTime.version("old"),
      async validate() {
        if (++validations === 1) {
          await fs.unlink(link)
          await fs.symlink(other.path, link, "dir")
        }
      },
    }),
  ).rejects.toThrow("changed")
  expect(await Bun.file(path.join(original, "a.txt")).text()).toBe("old")
  expect(await Bun.file(path.join(other.path, "a.txt")).text()).toBe("external")
  const controller = new AbortController()
  await expect(
    FileMutation.write({
      path: path.join(original, "a.txt"),
      content: "new",
      signal: controller.signal,
      async validate() {
        controller.abort(new Error("cancelled"))
      },
    }),
  ).rejects.toThrow("cancelled")
  expect((await fs.readdir(original)).sort()).toEqual(["a.txt"])
})
