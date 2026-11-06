import { describe, expect, spyOn, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Bus } from "@ericsanchezok/synergy-harness/bus"
import { ScopeContext } from "@ericsanchezok/synergy-harness/scope/context"
import { WorkspaceFileStatus } from "../../src/workspace-file/status"
import { WorktreeProcess } from "../../src/workspace/process"
import { tmpdir } from "@ericsanchezok/synergy-harness/test/support/fixture"
import { afterAll as afterRuntimeTests } from "bun:test"
import { testRuntime } from "../support/runtime"
const runtime = await testRuntime()

async function withWorkspace<T>(init: (dir: string) => Promise<void>, fn: (dir: string) => Promise<T>): Promise<T> {
  await using tmp = await tmpdir({ git: true, init })
  return ScopeContext.provide({
    scope: await tmp.scope(),
    fn: async () => {
      WorkspaceFileStatus.invalidate()
      try {
        return await fn(tmp.path)
      } finally {
        WorkspaceFileStatus.invalidate()
      }
    },
  })
}

describe("WorkspaceFileStatus", () => {
  test("reads renamed, modified and untracked paths with at most two native commands", () =>
    runtime.run(async () => {
      await withWorkspace(
        async (dir) => {
          await Bun.write(path.join(dir, "before.txt"), "same\n".repeat(30))
          await Bun.write(path.join(dir, "modified.txt"), "old\n")
          for (const args of [
            ["add", "."],
            ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "fixture"],
          ]) {
            const child = Bun.spawn(["git", ...args], { cwd: dir, stdout: "ignore", stderr: "pipe" })
            expect(await child.exited).toBe(0)
          }
          await fs.rename(path.join(dir, "before.txt"), path.join(dir, "after.txt"))
          const stage = Bun.spawn(["git", "add", "-A"], { cwd: dir, stdout: "ignore", stderr: "pipe" })
          expect(await stage.exited).toBe(0)
          await Bun.write(path.join(dir, "modified.txt"), "new\nextra\n")
          await Bun.write(path.join(dir, "untracked\tfile.txt"), "untracked\n")
        },
        async () => {
          const commands = spyOn(WorktreeProcess, "run")
          try {
            const summary = await WorkspaceFileStatus.summary({ force: true })
            expect(summary.files).toEqual([
              expect.objectContaining({ path: "after.txt", status: "renamed" }),
              expect.objectContaining({ path: "modified.txt", status: "modified", added: 2, removed: 1 }),
              expect.objectContaining({ path: "untracked\tfile.txt", status: "untracked" }),
            ])
            expect(commands.mock.calls.length).toBeLessThanOrEqual(2)
          } finally {
            commands.mockRestore()
          }
        },
      )
    }))

  test("cached status retains the event watermark from its original read", () =>
    runtime.run(async () => {
      await withWorkspace(
        async () => {},
        async () => {
          const seq = Bus.currentSeq()
          const first = await WorkspaceFileStatus.summary()
          expect(first.sync).toEqual({ epoch: Bus.epoch(), seq })
          expect((await WorkspaceFileStatus.summary()).sync).toEqual(first.sync)
        },
      )
    }))

  test("does not read large untracked files for line counts", () =>
    runtime.run(async () => {
      await withWorkspace(
        async (dir) => {
          await Bun.write(path.join(dir, "large-untracked.txt"), "x".repeat(300 * 1024))
        },
        async () => {
          const summary = await WorkspaceFileStatus.summary({ force: true })
          const file = summary.files.find((item) => item.path === "large-untracked.txt")
          expect(file).toMatchObject({ path: "large-untracked.txt", status: "untracked" })
          expect(file?.added).toBeUndefined()
          expect(file?.removed).toBeUndefined()
        },
      )
    }))

  test("skips untracked line counts when the untracked set is too large", () =>
    runtime.run(async () => {
      await withWorkspace(
        async (dir) => {
          await fs.mkdir(path.join(dir, "many"), { recursive: true })
          await Promise.all(
            Array.from({ length: 201 }, (_, index) =>
              Bun.write(path.join(dir, "many", `file-${index}.txt`), "one\ntwo\n"),
            ),
          )
        },
        async () => {
          const summary = await WorkspaceFileStatus.summary({ force: true })
          const file = summary.files.find((item) => item.path === "many/file-0.txt")
          expect(file).toMatchObject({ path: "many/file-0.txt", status: "untracked" })
          expect(file?.added).toBeUndefined()
          expect(file?.removed).toBeUndefined()
        },
      )
    }))
})

afterRuntimeTests(() => runtime.close())
